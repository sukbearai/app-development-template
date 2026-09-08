import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export function isolatedEnvironment(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (source[key]) env[key] = source[key];
  }
  return { ...env, CI: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', npm_config_userconfig: '/dev/null' };
}
export function coldStartOptions(args) {
  if (args.some(arg => !['--json', '--help'].includes(arg)) || args.length > 1) {
    throw Object.assign(new Error('Use --json or --help; no other arguments are accepted.'), { code: 'INVALID_ARGUMENT' });
  }
  return { json: args.includes('--json'), help: args.includes('--help') };
}
export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw Object.assign(new Error('Install Node 22.12 or newer before running cold-start.'), { code: 'NODE_UNSUPPORTED' });
  }
}
export async function exportCheckout(root, destination) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, env: isolatedEnvironment() }).toString().split('\0').filter(Boolean);
  const hash = createHash('sha256');
  let copied = 0;
  for (const file of [...new Set(files)].sort()) {
    if (file.split('/').some(part => ['node_modules', '.git', '.verification', 'artifacts'].includes(part))) continue;
    if (/^\.env(?:\.|$)/.test(path.basename(file)) && !file.endsWith('.example')) continue;
    const source = path.join(root, file);
    const info = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!info) continue;
    if (!info.isFile()) throw Object.assign(new Error(`Source export requires regular files: ${file}`), { code: 'UNSAFE_SOURCE' });
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await copyFile(source, path.join(destination, file));
    hash.update(file).update('\0').update(await readFile(path.join(destination, file))).update('\0');
    copied++;
  }
  return { gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: isolatedEnvironment(), encoding: 'utf8' }).trim(), sourceSha256: hash.digest('hex'), files: copied };
}
export async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
export function commandRunner(cwd, env, write) {
  const children = new Set();
  let interrupted = false;
  function launch(program, args, cleanup = false) {
    if (interrupted && !cleanup) throw Object.assign(new Error('Cold start interrupted.'), { code: 'INTERRUPTED' });
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once('error', error => {
        children.delete(child);
        reject(Object.assign(new Error(`${program} cannot start. Install it and verify PATH.`), { code: error.code === 'ENOENT' ? 'DEPENDENCY_MISSING' : 'PROCESS_START_FAILED' }));
      });
      child.once('close', (code, signal) => {
        children.delete(child);
        write(output);
        write(errors);
        if (code === 0) resolve(output.trim());
        else reject(Object.assign(new Error(`${program} exited ${code ?? signal}; inspect run.log.`), { code: interrupted ? 'INTERRUPTED' : 'COMMAND_FAILED' }));
      });
    });
    // A long-lived server can exit while readiness or another command is being awaited.
    void done.catch(() => {});
    return { child, done };
  }
  async function stop() {
    await Promise.all([...children].map(async child => {
      const closed = new Promise(resolve => child.once('close', resolve));
      const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      kill('SIGTERM');
      const timeout = setTimeout(() => kill('SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(timeout); }
    }));
  }
  return { launch, run: (program, args, cleanup) => launch(program, args, cleanup).done,
    stop, interrupt() { interrupted = true; return stop(); }, isInterrupted: () => interrupted };
}
