#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../../../..', import.meta.url)));
const lock = JSON.parse(readFileSync(`${root}/apps/web/.vinext/dev/lock.json`, 'utf8'));
const port = Number(process.env.PSTACK_VERIFY_PORT || 4173);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid verification port');
assert.ok(Number.isInteger(lock.pid) && lock.pid > 0, 'Invalid vinext owner PID');
assert.equal(lock.cwd, `${root}/apps/web`, 'Lock belongs to another checkout');
assert.equal(lock.port, port, 'vinext moved to a different port');
assert.equal(lock.hostname, '127.0.0.1');
if (process.env.PSTACK_VERIFY_STARTED_MS) {
  assert.ok(lock.startedAt >= Number(process.env.PSTACK_VERIFY_STARTED_MS), 'Server predates this verification run');
}
process.kill(lock.pid, 0);
const listeners = execFileSync('lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/);
assert.ok(listeners.includes(String(lock.pid)), 'The lock owner does not own the listening port');
const response = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(10_000) });
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type') || '', /application\/json/);
assert.deepEqual(await response.json(), { message: 'Hello from vinext' });
const pkg = JSON.parse(readFileSync(`${root}/apps/web/package.json`, 'utf8'));
assert.equal(pkg.name, '@pstack/web');
console.log(JSON.stringify({ status: 'ready', root, lock, node: process.version, vinext: pkg.dependencies.vinext, baseURL: `http://127.0.0.1:${port}` }, null, 2));
