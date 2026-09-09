import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { env } from "../src/env.ts";
import { assertLoginRateLimit } from "../src/rate-limit.ts";
import { handleTrpcRequest } from "../src/trpc-handler.ts";
import { rpcMetricsSnapshot } from "../src/trpc-metrics.ts";

const origin = "http://localhost:3000";
const traceId = "trace_rpc_transport_test";
function request(path, options = {}) {
  return new Request(`${origin}/api/trpc/${path}`, {
    ...options,
    headers: { "x-trace-id": traceId, ...options.headers },
  });
}
async function expectError(req, status, code) {
  const response = await handleTrpcRequest(req);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.data.businessCode, code);
  assert.equal(body.error.data.traceId, traceId);
  assert.equal(response.headers.get("x-trace-id"), traceId);
  assert.equal("stack" in body.error.data, false);
  return { response, body };
}

test("fetch adapter reports missing identity before parsing admin mutation input", async () => {
  await expectError(
    request("users.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    401,
    "UNAUTHENTICATED",
  );
});

test("unknown query and invalid login input keep trace correlation without raw input", async () => {
  await expectError(request("unknown.query"), 404, "NOT_FOUND");
  const { body } = await expectError(
    request("auth.login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: "test", password: { secret: "should-not-leak" } }),
    }),
    400,
    "VALIDATION_FAILED",
  );
  assert.equal(JSON.stringify(body).includes('"secret"'), false);
});

test("logout accepts the empty body emitted by a void httpLink mutation and clears one cookie", async () => {
  const response = await handleTrpcRequest(
    request("auth.logout", { method: "POST", headers: { "content-type": "application/json" } }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { data: { ok: true } } });
  assert.equal(response.headers.getSetCookie().length, 1);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("cookie mutations enforce origin before reading malformed JSON", async () => {
  await expectError(
    request("auth.logout", {
      method: "POST",
      headers: {
        cookie: "pstack_session=invalid",
        origin: "http://attacker.invalid",
        "content-type": "application/json",
      },
      body: "{",
    }),
    403,
    "CSRF_ORIGIN_INVALID",
  );
});

test("fetch adapter accepts case-insensitive JSON media types", async () => {
  for (const contentType of ["Application/JSON", "APPLICATION/JSON; charset=UTF-8"]) {
    const response = await handleTrpcRequest(
      request("auth.logout", {
        method: "POST",
        headers: { "content-type": contentType },
        body: "null",
      }),
    );
    assert.equal(response.status, 200, contentType);
    assert.deepEqual(await response.json(), { result: { data: { ok: true } } });
    assert.equal(response.headers.getSetCookie().length, 1);
  }
});

test("non-JSON and invalid JSON bodies produce typed transport failures", async () => {
  await expectError(
    request("auth.login", { method: "POST", body: "password=secret" }),
    415,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectError(
    request("auth.login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"password":"secret"',
    }),
    400,
    "INVALID_JSON",
  );
});

test("64 KiB bound uses bytes read even when content-length lies", async () => {
  await expectError(
    request("auth.login", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: JSON.stringify({ password: "x".repeat(65536) }),
    }),
    413,
    "JSON_TOO_LARGE",
  );
});

test("rejects batch mode and comma paths before executing logout", async () => {
  for (const path of ["auth.logout?batch=1", "auth.logout,auth.logout"]) {
    const { response } = await expectError(
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      400,
      "BATCHING_DISABLED",
    );
    assert.equal(response.headers.has("set-cookie"), false);
  }
});

test("RPC metrics record registered procedure IDs and exclude arbitrary paths", () => {
  const metrics = rpcMetricsSnapshot();
  assert.ok(
    metrics.some(
      (metric) =>
        metric.operationId === "trpc.auth.logout" && metric.status === 200 && metric.count > 0,
    ),
  );
  assert.equal(
    metrics.some((metric) => metric.operationId.includes("unknown.query")),
    false,
  );
});

test("account throttling keeps business details and retry-after on the real adapter", async () => {
  const account = "rpc-limited-account";
  for (let attempt = 0; attempt < env.LOGIN_RATE_LIMIT_MAX; attempt++)
    await assertLoginRateLimit(`login:account:${account}`);
  const { response, body } = await expectError(
    request("auth.login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, password: "not-logged" }),
    }),
    429,
    "RATE_LIMITED",
  );
  assert.equal(
    Number(response.headers.get("retry-after")),
    body.error.data.details.retryAfterSeconds,
  );
  assert.ok(body.error.data.details.retryAfterSeconds > 0);
});

test("global login throttling runs before body reads even for malformed requests", () => {
  const script = `
    import { handleTrpcRequest } from './src/trpc-handler.ts';
    const invoke = () => handleTrpcRequest(new Request('http://localhost:3000/api/trpc/auth.login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'trace_global_limit' }, body: '{' }));
    const first = await invoke();
    const second = await invoke();
    console.log(JSON.stringify({ first: first.status, second: second.status, retry: second.headers.get('retry-after'), body: await second.json() }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        LOG_LEVEL: "error",
        LOGIN_RATE_LIMIT_GLOBAL_MAX: "1",
        RATE_LIMIT_DRIVER: "memory",
        WEB_REPLICAS: "1",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.first, 400);
  assert.equal(result.second, 429);
  assert.equal(result.body.error.data.businessCode, "RATE_LIMITED");
  assert.equal(result.body.error.data.traceId, "trace_global_limit");
  assert.ok(Number(result.retry) > 0);
});

test("unexpected service failures return no credentials or stack and log one safe diagnostic", () => {
  const script = `
    import { handleTrpcRequest } from './src/trpc-handler.ts';
    const response = await handleTrpcRequest(new Request('http://localhost:3000/api/trpc/auth.login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'trace_private_failure' }, body: JSON.stringify({ account: 'sensitive-account', password: 'sensitive-password' }) }));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_LEVEL: "error",
        DATABASE_URL: "postgresql://private-user:private-password@127.0.0.1:1/unavailable",
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: "100",
        RATE_LIMIT_DRIVER: "memory",
        WEB_REPLICAS: "1",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.status, 500);
  assert.equal(result.body.error.data.businessCode, "INTERNAL_ERROR");
  assert.equal(result.body.error.data.traceId, "trace_private_failure");
  assert.deepEqual(result.body.error.data.details, {});
  assert.equal("stack" in result.body.error.data, false);
  const errors = child.stderr
    .trim()
    .split("\n")
    .filter((line) => line.trimStart().startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].level, "error");
  assert.equal(errors[0].fields.traceId, "trace_private_failure");
  assert.match(child.stderr, /ECONNREFUSED/);
  assert.doesNotMatch(
    child.stdout + child.stderr,
    /sensitive-account|sensitive-password|private-user|private-password/,
  );
});
