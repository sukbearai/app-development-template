import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkNode, coldStartOptions, commandRunner, exportCheckout, isolatedEnvironment } from '../cold-start-support.mjs';

test('cold start rejects unknown arguments and old Node before resources', () => {
  assert.throws(() => coldStartOptions(['--production']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => coldStartOptions(['--json', '--json']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => checkNode('22.11.0'), { code: 'NODE_UNSUPPORTED' });
  assert.doesNotThrow(() => checkNode('22.12.0'));
  const env = isolatedEnvironment({ PATH: '/bin', DATABASE_URL: 'shared', NODE_OPTIONS: 'injected', COMPOSE_PROJECT_NAME: 'shared', UNKNOWN_ENV: 'unsafe' });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.UNKNOWN_ENV, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.COMPOSE_PROJECT_NAME, undefined);
});
test('missing executable produces actionable stable dependency error', async () => {
  const runner = commandRunner(tmpdir(), isolatedEnvironment(), () => {});
  await assert.rejects(runner.run('/missing/cold-start-binary', []), { code: 'DEPENDENCY_MISSING', message: /Install it and verify PATH/ });
});
test('interrupt closes the owned process group and refuses new work', async () => {
  const runner = commandRunner(tmpdir(), isolatedEnvironment(), () => {});
  const running = runner.launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise(resolve => running.child.once('spawn', resolve));
  await runner.interrupt();
  await assert.rejects(running.done, { code: 'INTERRUPTED' });
  assert.throws(() => process.kill(running.child.pid, 0), { code: 'ESRCH' });
  assert.throws(() => runner.launch(process.execPath, ['-e', '']), { code: 'INTERRUPTED' });
  await runner.run(process.execPath, ['-e', ''], true);
});
test('export includes dirty and new source while rejecting escaping symlinks and excluding dotenv', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cold-export-test-'));
  const source = path.join(directory, 'source');
  const output = path.join(directory, 'output');
  await mkdir(source);
  try {
    execFileSync('git', ['init', '-q'], { cwd: source });
    await writeFile(path.join(source, '.gitignore'), '.env\n');
    await writeFile(path.join(source, 'tracked.txt'), 'before');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source });
    await writeFile(path.join(source, 'tracked.txt'), 'after');
    await writeFile(path.join(source, 'new.txt'), 'new');
    await writeFile(path.join(source, '.env'), 'DATABASE_URL=shared');
    const identity = await exportCheckout(source, output);
    assert.equal(await readFile(path.join(output, 'tracked.txt'), 'utf8'), 'after');
    assert.equal(await readFile(path.join(output, 'new.txt'), 'utf8'), 'new');
    await assert.rejects(readFile(path.join(output, '.env')), { code: 'ENOENT' });
    assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/);
    await symlink('/etc/passwd', path.join(source, 'escape'));
    await assert.rejects(exportCheckout(source, output), { code: 'UNSAFE_SOURCE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
