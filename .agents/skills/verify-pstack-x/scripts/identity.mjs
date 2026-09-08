import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function sourceHashes(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  return Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
}

export function sourceSha256(root) {
  return createHash('sha256').update(JSON.stringify(sourceHashes(root))).digest('hex');
}

export function buildSha256(root) {
  const build = path.join(root, 'apps/web/dist');
  const files = readdirSync(build, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => path.relative(build, path.join(entry.parentPath, entry.name))).sort();
  if (!files.length) throw new Error('Production build is empty');
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(path.join(build, file))).update('\0');
  return hash.digest('hex');
}

export function processIdentity(pid) {
  const result = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(result);
  if (!match) throw new Error(`Cannot identify process ${pid}`);
  return { ppid: Number(match[1]), pgid: Number(match[2]), processStarted: match[3] };
}
