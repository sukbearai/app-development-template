import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.join(root, '.verification', 'app');
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, 'run-'));
const mode = process.argv.includes('--ui') ? 'ui' : 'api';
const production = process.argv.includes('--production');
const containerName = `pstack-x-verify-${randomBytes(6).toString('hex')}`;
const pgPassword = randomBytes(24).toString('hex');
const adminPassword = randomBytes(24).toString('base64url');
const log = createWriteStream(path.join(output, 'run.log'));
let containerCreated = false;
let server;
let interrupted = false;
const commands = new Set();
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (/^(DATABASE_|E2E_|UI_FLOW_|APP_|SESSION_|RATE_LIMIT_|LOGIN_RATE_|REDIS_|KAFKA_|OUTBOX_|ASYNC_|UPLOAD_|OBJECT_STORAGE_|CLICKHOUSE_|BOOTSTRAP_)/.test(key)) delete childEnv[key];
}
Object.assign(childEnv, {
  APP_NAME: 'pstack-x', APP_ENV: 'test', NODE_ENV: 'test', RATE_LIMIT_DRIVER: 'memory',
  UPLOAD_STORAGE_DRIVER: 'local', UPLOAD_STORAGE_DIR: path.join(output, 'uploads'),
  OUTBOX_PUBLISHER: 'disabled', LOG_LEVEL: 'warn', SESSION_COOKIE_SECURE: 'false',
  BOOTSTRAP_ADMIN_ACCOUNT: 'admin', BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
  BOOTSTRAP_ADMIN_DISPLAY_NAME: 'Test administrator',
  UI_FLOW_ADMIN_ACCOUNT: 'admin', UI_FLOW_ADMIN_PASSWORD: adminPassword,
  SERVICE_TOKEN: randomBytes(32).toString('hex'),
});

function command(program, args, { env = childEnv, capture = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error("Verification interrupted");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    commands.add(child);
    child.once('close', () => commands.delete(child));
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (!capture) { process.stdout.write(chunk); log.write(chunk); } });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${program} ${args[0]} failed (${code ?? signal})`)));
  });
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  await new Promise(resolve => socket.close(resolve));
  return address.port;
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const timer = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch {} }, 10_000);
  try { await exited; } finally { clearTimeout(timer); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  for (const child of commands) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  void stopServer();
  process.exitCode = 1;
});
console.log(`Evidence: ${output}`);
try {
  await command('docker', ['run', '-d', '--name', containerName, '--label', 'pstack-x.test=app', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=pstack_test', '-p', '127.0.0.1::5432', process.env.PSTACK_TEST_POSTGRES_IMAGE || 'postgres:17-bullseye'], { capture: true, env: { ...childEnv, POSTGRES_PASSWORD: pgPassword } });
  containerCreated = true;
  const mapped = await command('docker', ['port', containerName, '5432/tcp'], { capture: true });
  const pgPort = Number(mapped.split(':').at(-1));
  childEnv.DATABASE_URL = `postgresql://postgres:${pgPassword}@127.0.0.1:${pgPort}/pstack_test`;
  for (let attempt = 0; ; attempt++) {
    try { await command('docker', ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'pstack_test'], { capture: true }); break; }
    catch (error) { if (attempt === 60) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  await command('pnpm', ['--filter', '@pstack/database', 'db:migrate']);
  await command('pnpm', ['--filter', '@pstack/server', 'admin:bootstrap']);
  await command('pnpm', ['--filter', '@pstack/database', 'db:integration']);
  const port = await freePort();
  childEnv.APP_ORIGIN = `http://127.0.0.1:${port}`;
  childEnv.SMOKE_BASE_URL = childEnv.APP_ORIGIN;
  childEnv.PSTACK_VERIFY_PORT = String(port);
  if (mode === 'ui' && !production) {
    await command('bash', ['.agents/skills/verify-pstack-x/scripts/run.sh']);
  } else {
    if (production) await command('pnpm', ['build']);
    async function launchServer() {
    server = spawn('pnpm', ['--filter', '@pstack/web', production ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...childEnv, ...(production ? { NODE_ENV: 'production', APP_ENV: 'production' } : {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => log.write(chunk));
    server.stderr.on('data', chunk => log.write(chunk));
    const deadline = Date.now() + 60_000;
    while (true) {
      if (interrupted) throw new Error('Verification interrupted');
      if (server.exitCode !== null) throw new Error('Web server exited before readiness; inspect run.log');
      try {
        const response = await fetch(new URL('/api/hello', childEnv.APP_ORIGIN), { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error('Web server readiness timed out');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    }
    await launchServer();
    await command('node', ['apps/web/scripts/smoke.mjs']);
    if (production) {
      await stopServer();
      childEnv.POSTGRES_TOOLS = 'docker';
      childEnv.POSTGRES_TOOL_IMAGE = process.env.PSTACK_TEST_POSTGRES_IMAGE || 'postgres:17-bullseye';
      const backupPath = path.join(output, 'backup');
      await command('node', ['scripts/db-backup.mjs', 'create', '--id', 'app', '--output', backupPath]);
      const control = new Client({ connectionString: childEnv.DATABASE_URL });
      await control.connect();
      try { await control.query('CREATE DATABASE pstack_restored'); } finally { await control.end(); }
      const restored = new URL(childEnv.DATABASE_URL);
      restored.pathname = '/pstack_restored';
      childEnv.DATABASE_URL = restored.href;
      await command('node', ['scripts/db-backup.mjs', 'restore', '--file', path.join(backupPath, 'app.dump'), '--confirm']);
      await command('pnpm', ['--filter', '@pstack/database', 'db:migrate']);
      await command('pnpm', ['--filter', '@pstack/database', 'db:integration']);
      await launchServer();
      await command('node', ['apps/web/scripts/smoke.mjs']);
    }

  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', mode, production, containerName, databaseRestore: production, boundary: 'Owned ephemeral PostgreSQL and real application; production mode restores the application database and verifies login after migration. Uploaded files stay in the same owned local directory; object backups and optional middleware are verified separately.' }, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', mode, production, error: error.message }, null, 2));
  throw error;
} finally {
  await stopServer();
  if (containerCreated) await command('docker', ['rm', '-f', '-v', containerName], { capture: true, cleanup: true });
  else if (interrupted) {
    const owned = await command('docker', ['ps', '-aq', '--filter', `name=^/${containerName}$`, '--filter', 'label=pstack-x.test=app'], { capture: true, cleanup: true });
    if (owned) await command('docker', ['rm', '-f', '-v', owned], { capture: true, cleanup: true });
  }
  log.end();
  console.log(`Evidence retained: ${output}`);
}
