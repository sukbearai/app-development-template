import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Context, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from 'effect/unstable/httpapi';

const checks = [];
const Resource = Context.Service('analysis/Resource');
let acquired = 0;
let released = 0;
const resourceLayer = Layer.effect(Resource, Effect.acquireRelease(
  Effect.sync(() => { acquired++; return { value: 'ready' }; }),
  () => Effect.sync(() => { released++; })
));
const runtime = ManagedRuntime.make(resourceLayer);
try {
  const use = Effect.gen(function* () { return (yield* Resource).value; });
  assert.equal(await runtime.runPromise(use), 'ready');
  assert.equal(await runtime.runPromise(use), 'ready');
  assert.equal(acquired, 1);
  assert.equal(released, 0);
} finally { await runtime.dispose(); }
assert.equal(released, 1);
checks.push('ManagedRuntime shares one Layer resource and releases it on dispose');

let failedRelease = false;
const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
  yield* Effect.acquireRelease(Effect.succeed('resource'), () => Effect.sync(() => { failedRelease = true; }));
  return yield* Effect.fail({ _tag: 'ProbeFailure' });
})));
assert.equal(exit._tag, 'Failure');
assert.equal(failedRelease, true);
checks.push('Scope finalizer runs on typed failure');

const Greeting = Schema.Struct({ message: Schema.String });
const Api = HttpApi.make('analysis-api').add(HttpApiGroup.make('hello').add(
  HttpApiEndpoint.post('echo', '/api/echo', { payload: Greeting, success: Greeting })
));
const handlers = HttpApiBuilder.group(Api, 'hello', handlers => handlers.handle('echo', ({ payload }) => Effect.succeed(payload)));
const routes = HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices));
const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
const statuses = [];
try {
  const valid = await handler(new Request('http://probe/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) }));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { message: 'hello' });
  statuses.push(valid.status);
  const invalid = await handler(new Request('http://probe/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 123 }) }));
  assert.equal(invalid.status, 400);
  statuses.push(invalid.status);
} finally { await dispose(); }
const spec = OpenApi.fromApi(Api);
assert.ok(spec.paths['/api/echo'].post.requestBody);
assert.ok(spec.paths['/api/echo'].post.responses['200']);
writeFileSync(new URL('openapi.json', import.meta.url), JSON.stringify(spec, null, 2));
checks.push('One HttpApi schema produces a Web Request handler, validates payload, encodes response, and generates OpenAPI');
const output = { version: JSON.parse(readFileSync(new URL('node_modules/effect/package.json', import.meta.url))).version, checks, statuses, boundary: 'Published effect 4.0.0-rc.112 package, in-process Web Request/Response; no vinext integration, browser, database, Kafka, or network listener.' };
writeFileSync(new URL('result.json', import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
