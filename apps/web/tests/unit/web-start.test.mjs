import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('production launcher loads proxy trust before importing vinext server', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pstack-start-'));
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, NODE_ENV: 'production', WEB_SHUTDOWN_TIMEOUT_MS: '1000' };
  delete env.VINEXT_TRUST_PROXY;
  delete env.VINEXT_TRUSTED_HOSTS;
  let child;
  let exited;
  try {
    await mkdir(path.join(directory, 'dist/server'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(directory, 'dist/server/index.js'), 'export default request => Response.json({ url: request.url });');
    await writeFile(path.join(directory, '.env.production'), 'VINEXT_TRUST_PROXY=1\nVINEXT_TRUSTED_HOSTS=public.example.test\n');
    child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/start.mjs', import.meta.url)), '--hostname', '127.0.0.1', '--port', String(port)], { cwd: directory, env, stdio: 'ignore' });
    exited = once(child, 'exit');
    const deadline = Date.now() + 10000;
    let response;
    while (!response) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/probe`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.test' },
          signal: AbortSignal.timeout(500),
        });
      } catch {
        assert.equal(child.exitCode, null, 'Launcher exited before accepting requests');
        assert.ok(Date.now() < deadline, 'Launcher readiness timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: 'https://public.example.test/probe' });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
