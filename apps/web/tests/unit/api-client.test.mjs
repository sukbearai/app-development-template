import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { requestJson, ApiRequestError } from '../../components/api-client.ts';

test('client parses success with the caller schema and rejects wrong output', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ traceId: 'test', data: { count: 'invalid' } }));
  await assert.rejects(requestJson('/api/test', z.object({ count: z.number() })));
});

test('client preserves server error code, trace and details without exposing raw error bodies', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ traceId: 'trace_example', error: { code: 'CONFLICT', message: '已存在', details: { field: 'account' } } }, { status: 409 }));
  await assert.rejects(requestJson('/api/test', z.unknown()), error => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.traceId, 'trace_example');
    assert.equal(error.code, 'CONFLICT');
    assert.deepEqual(error.details, { field: 'account' });
    return true;
  });
});

test('client does not show arbitrary proxy HTML to the user', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>internal server information</html>', { status: 502 }));
  await assert.rejects(requestJson('/api/test', z.unknown()), error => error.message === '请求失败 (502)' && error.code === 'INVALID_RESPONSE');
});
