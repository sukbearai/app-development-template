import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebLifecycle } from '../../scripts/process-lifecycle.mjs';
import { closeDatabase, getPool } from '@pstack/database/client';
import { trackWebWork } from '@pstack/database/process-lifecycle';
import { withAccessLog } from '@pstack/server/logger';

test('the application bridge drains accepted work before ending its actual pg Pool', async () => {
  const lifecycle = createWebLifecycle();
  const previous = process.pstackWebLifecycle;
  const databaseURL = process.env.DATABASE_URL;
  process.pstackWebLifecycle = lifecycle;
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/unused';
  const pool = getPool();
  const pending = Promise.withResolvers();
  try {
    const work = trackWebWork(() => pending.promise);
    lifecycle.beginDrain();
    const drained = lifecycle.drain();
    await Promise.resolve();
    assert.equal(pool.ended, false);
    const rejected = await withAccessLog(new Request('http://localhost/api/auth/login', { method: 'POST' }), 'shutdown_test', async () => {
      assert.fail('New business work ran after draining began');
    });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, 'SERVICE_UNAVAILABLE');
    pending.resolve('committed');
    assert.equal(await work, 'committed');
    await drained;
    assert.equal(pool.ended, true, 'The actual registered pool must end before the process exits');
  } finally {
    pending.resolve();
    await closeDatabase();
    process.pstackWebLifecycle = previous;
    if (databaseURL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseURL;
  }
});

test('resource cleanup awaits every disposer and reports failures', async () => {
  const lifecycle = createWebLifecycle();
  const pending = Promise.withResolvers();
  let released = false;
  lifecycle.registerCleanup(async () => { throw new Error('cleanup failed'); });
  lifecycle.registerCleanup(async () => { await pending.promise; released = true; });
  lifecycle.beginDrain();
  const result = assert.rejects(lifecycle.drain(), AggregateError);
  await Promise.resolve();
  assert.equal(released, false);
  pending.resolve();
  await result;
  assert.equal(released, true);
  await assert.rejects(lifecycle.trackWork(async () => assert.fail('Admission reopened')));
});
