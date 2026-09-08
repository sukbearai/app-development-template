import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { envSchema } from "../src/env.ts";
import { readBoundedFormData } from "../src/upload-memory-limits.ts";
import { ApiError, fail, getTraceId, readJson } from "../src/api-response.ts";
import { asyncIdentifierSchema } from "@pstack/contracts";
import { redact, withAccessLog } from "../src/logger.ts";
import { verifyRequestOrigin, setSessionCookie } from "../src/request-auth.ts";

import {
  buildAsyncRuntimeHealthSnapshot,
  buildRuntimePlanFromEnv,
} from "../src/async-runtime-health-service.ts";

const healthNow = new Date("2026-09-08T00:00:00.000Z");
function backlogHealth(events, options = {}) {
  return buildAsyncRuntimeHealthSnapshot({
    now: healthNow,
    runtimePlan: buildRuntimePlanFromEnv({}),
    tasks: [],
    quarantine: { messageQuarantine: 0, recoveryQuarantine: 0 },
    thresholds: { pendingWarn: 50, pendingBlocked: 200, failedWarn: 10 },
    outboxEvents: events.map((event) => ({
      topic: "app.tasks", status: "pending", createdAt: healthNow, ...event,
    })),
    ...options,
  });
}

for (const [pending, expected] of [[49, "ok"], [50, "degraded"], [199, "degraded"], [200, "blocked"]]) {
  test(`async runtime health reports ${pending} pending as ${expected}`, () => {
    const snapshot = backlogHealth([{ count: pending }]);
    assert.equal(snapshot.status, expected);
    const alert = snapshot.alerts.find((item) => item.metric === "pending");
    assert.equal(alert?.value, pending < 50 ? undefined : pending);
    assert.deepEqual(snapshot.blockedReasons, pending >= 200 ? ["outbox_pending_blocked"] : []);
  });
}
for (const [age, expected] of [[31999, "ok"], [32000, "degraded"]]) {
  test(`async runtime health reports pending age ${age} as ${expected}`, () => {
    const snapshot = backlogHealth([{ createdAt: new Date(healthNow.getTime() - age) }]);
    assert.equal(snapshot.status, expected);
    assert.equal(snapshot.alerts.find((item) => item.reason === "outbox_oldest_pending_age")?.threshold,
      age < 32000 ? undefined : 32000);
  });
}
test("async runtime health applies pending thresholds across topics", () => {
  const snapshot = backlogHealth([{ topic: "one", count: 100 }, { topic: "two", count: 100 }]);
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.alerts.find((item) => item.reason === "outbox_pending_blocked").value, 200);
});
test("async runtime health retains topic and stale-lock diagnostics", () => {
  const snapshot = backlogHealth([
    { status: "dead_letter", count: 1 },
    { status: "failed", count: 1 },
    { status: "processing", staleCount: 1 },
  ], { staleLockMs: 1234 });
  assert.deepEqual(snapshot.alerts.map((item) => item.reason), [
    "async_topic_dead_letter", "async_topic_failed_backlog", "outbox_stale_processing_lock",
  ]);
  assert.equal(snapshot.alerts[2].threshold, 1234);
});

test("async runtime health applies custom thresholds to aggregate metrics", () => {
  const thresholds = { pendingWarn: 5, pendingBlocked: 20, failedWarn: 2 };
  const snapshot = backlogHealth([
    { topic: "one", count: 10 }, { topic: "two", count: 10 },
    { topic: "one", status: "failed" }, { topic: "two", status: "failed" },
  ], { thresholds });
  assert.equal(snapshot.status, "blocked");
  const globalAlerts = snapshot.alerts.filter((item) => !item.topic);
  assert.deepEqual(globalAlerts.map(({ reason, value, threshold }) => [reason, value, threshold]), [
    ["outbox_pending_blocked", 20, 20], ["outbox_failed_backlog", 2, 2],
  ]);
});
test("async runtime health includes failed retries in the oldest pending age", () => {
  const snapshot = backlogHealth([{ status: "failed", createdAt: new Date(healthNow.getTime() - 32000) }]);
  assert.equal(snapshot.alerts.find((item) => item.reason === "outbox_oldest_pending_age").value, 32000);
});

for (const [quarantine, expected] of [
  [{ messageQuarantine: 1, recoveryQuarantine: 0 }, ["async_message_quarantine"]],
  [{ messageQuarantine: 0, recoveryQuarantine: 1 }, ["async_recovery_quarantine"]],
  [{ messageQuarantine: 1, recoveryQuarantine: 1 }, ["async_message_quarantine", "async_recovery_quarantine"]],
]) {
  test(`administrator health reports quarantine ${JSON.stringify(quarantine)}`, () => {
    const snapshot = backlogHealth([], { quarantine });
    assert.equal(snapshot.status, "blocked");
    assert.deepEqual(snapshot.blockedReasons, expected);
    assert.deepEqual(snapshot.alerts.map(({ reason }) => reason), expected);
  });
}

test("request trace IDs preserve valid identities and replace invalid metadata before use", () => {
  for (const value of ["client-trace", "a".repeat(2000), "é".repeat(1000)]) {
    const traceId = getTraceId(new Request("https://app.example", { headers: { "x-trace-id": value } }));
    assert.equal(traceId, value);
    assert.equal(asyncIdentifierSchema.parse(traceId), traceId);
  }
  for (const value of [undefined, "   ", "a".repeat(2400), "a".repeat(6000), "é".repeat(1001)]) {
    const traceId = getTraceId(new Request("https://app.example", { headers: value === undefined ? {} : { "x-trace-id": value } }));
    assert.match(traceId, /^trace_[0-9a-f-]{36}$/);
    assert.equal(asyncIdentifierSchema.parse(traceId), traceId);
  }
});

test("production login logs a database failure without exposing credentials to logs or clients", () => {
  const source = `
    const { POST } = await import(${JSON.stringify(new URL("../../../apps/web/app/api/auth/login/route.ts", import.meta.url).href)});
    const response = await POST(new Request('https://app.example/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'failure-proof', password: 'synthetic-password-never-log' })
    }));
    console.log(JSON.stringify({ responseStatus: response.status, responseBody: await response.json() }));
    const { closeDatabase } = await import('@pstack/database/client');
    await closeDatabase();
  `;
  const output = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: "https://app.example", DATABASE_URL: "postgres://proof-user:synthetic-db-secret@127.0.0.1:1/proof", RATE_LIMIT_DRIVER: "memory", WEB_REPLICAS: "1", LOG_LEVEL: "error" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output.status, 0, output.stderr);
  const response = output.stdout.trim().split("\n").map(line => JSON.parse(line)).find(line => line.responseStatus);
  assert.equal(response.responseStatus, 500);
  assert.equal(response.responseBody.error.code, "INTERNAL_ERROR");
  const errors = output.stderr.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.equal(errors.length, 1, "the actual route must log its unknown failure once at LOG_LEVEL=error");
  assert.equal(errors[0].level, "error");
  assert.equal(errors[0].fields.traceId, response.responseBody.traceId);
  assert.match(JSON.stringify(errors[0]), /ECONNREFUSED/);
  assert.ok(errors[0].fields.error.frames.length > 0, "the real database failure retains source locations");
  assert.doesNotMatch(output.stdout + output.stderr, /synthetic-db-secret|synthetic-password-never-log/);
});
test("production diagnostics keep bounded causes and source locations without error payloads", () => {
  const source = `
    const { redact, withAccessLog } = await import(${JSON.stringify(new URL("../src/logger.ts", import.meta.url).href)});
    const location = ${JSON.stringify(new URL("../src/auth-service.ts", import.meta.url).pathname)};
    const secret = 'synthetic-error-secret';
    const cause = Object.assign(new Error('SQL password=' + secret), {
      code: '23505', detail: secret, query: 'SELECT ' + secret, parameters: [secret]
    });
    const wrapped = new Error('Failed query: ' + secret, { cause });
    wrapped.name = secret;
    wrapped.stack = [
      secret,
      '    at ' + secret + ' (' + location + ':42:9)',
      '    at https://user:' + secret + '@host/file.js:1:1',
      '    at /outside/' + secret + '.js:1:1',
      '    at ' + location + '?token=' + secret + ':1:1',
      ...Array(20).fill('    at ' + location + ':43:2')
    ].join('\\n');
    const cyclic = new Error(secret);
    cyclic.cause = cyclic;
    const deep = new Error(secret, { cause: new Error(secret, { cause: new Error(secret, { cause }) }) });
    const hostile = new Error(secret);
    for (const key of ['name', 'message', 'code', 'stack', 'cause'])
      Object.defineProperty(hostile, key, { get() { throw new Error(secret); } });
    const nonError = { get name() { throw new Error(secret); }, raw: secret };
    const values = [wrapped, cyclic, deep, hostile, nonError, secret, null, 12n, undefined];
    const responses = [];
    for (const value of values) {
      const response = await withAccessLog(new Request('https://app.example/api/auth/login', { method: 'POST' }), 'trace-safe', async () => { throw value; });
      responses.push({ status: response.status, body: await response.json() });
    }
    const unknownCode = Object.assign(new Error(secret), { code: secret });
    console.log(JSON.stringify({ direct: redact(wrapped), hostile: redact(hostile), unknownCode: redact(unknownCode), responses }));
  `;
  const output = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "error" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output.status, 0, output.stderr);
  assert.doesNotMatch(output.stdout + output.stderr, /synthetic-error-secret|Failed query|SELECT/);
  const result = JSON.parse(output.stdout);
  assert.equal(result.direct.message, "Operation failed");
  assert.equal(result.direct.cause.code, "23505");
  assert.deepEqual(result.direct.frames[0], { file: "packages/server/src/auth-service.ts", line: 42, column: 9 });
  assert.equal(result.direct.frames.length, 8);
  assert.equal(result.hostile.message, "Operation failed");
  assert.equal(result.unknownCode.code, undefined);
  const errors = output.stderr.trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  assert.equal(errors.length, result.responses.length);
  assert.equal(errors[1].fields.error.cause.message, "[CIRCULAR]");
  assert.equal(errors[2].fields.error.cause.cause.cause, undefined);
  for (const response of result.responses) {
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "INTERNAL_ERROR");
    assert.equal(response.body.traceId, "trace-safe");
  }
});
test("passwords require scrypt and verify the complete digest", async () => {
  assert.equal(await verifyPassword("admin", "plain:admin"), false);
  const encoded = await hashPassword("a-strong-generated-password");
  assert.equal(
    await verifyPassword("a-strong-generated-password", encoded),
    true,
  );
  assert.equal(await verifyPassword("wrong", encoded), false);
});
test("boolean config and cookie TTL use explicit values", () => {
  assert.equal(
    envSchema.parse({ OBJECT_STORAGE_FORCE_PATH_STYLE: "false" })
      .OBJECT_STORAGE_FORCE_PATH_STYLE,
    false,
  );
  assert.throws(() =>
    envSchema.parse({ OBJECT_STORAGE_FORCE_PATH_STYLE: "yes" }),
  );
  const response = setSessionCookie(new Response(), "id.secret");
  assert.match(response.headers.get("set-cookie"), /Max-Age=86400/);
});
test("outbox attempt policy defaults to five and rejects invalid database integers", () => {
  assert.equal(envSchema.parse({}).OUTBOX_MAX_ATTEMPTS, 5);
  assert.equal(envSchema.parse({ OUTBOX_MAX_ATTEMPTS: "2" }).OUTBOX_MAX_ATTEMPTS, 2);
  for (const value of ["0", "-1", "1.5", "invalid", "2147483648"])
    assert.throws(() => envSchema.parse({ OUTBOX_MAX_ATTEMPTS: value }));
});
test("forged forwarded headers cannot establish cookie write origin", () => {
  const request = new Request("https://app.example/api/users", {
    method: "POST",
    headers: {
      cookie: "pstack_session=id.secret",
      origin: "https://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(verifyRequestOrigin(request), false);
});
test("JSON parse and unknown error boundaries preserve safe status", async () => {
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    ),
    (error) => error.code === "INVALID_JSON",
  );
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    ),
    (error) => error.status === 415,
  );
  await assert.rejects(
    readJson(
      new Request("https://example.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(65537),
      }),
    ),
    (error) => error.status === 413,
  );
  const response = fail(
    new Error("postgres://admin:secret@example/database"),
    "trace",
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(
    JSON.stringify(
      redact({
        nested: { password: "sensitive" },
        error: new Error("postgres://user:pass@db/x token=hidden"),
      }),
    ),
    /sensitive|hidden|user:pass/,
  );
});
test("actual stream bytes enforce upload ceiling without content length", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: new Uint8Array(1024 * 1024 + 20),
  });
  await assert.rejects(
    readBoundedFormData(request, 10),
    (error) => error.status === 413,
  );
  const form = new FormData();
  form.append("file", new File(["hello"], "hello.txt"));
  const valid = await readBoundedFormData(
    new Request("https://example.test", { method: "POST", body: form }),
    100,
  );
  assert.equal(await valid.get("file").text(), "hello");
});
test("HTTP boundary rejects an invalid success body", async () => {
  const response = await withAccessLog(
    new Request("http://localhost/api/auth/login", { method: "POST" }),
    "trace",
    async () =>
      Response.json({ traceId: "trace", data: { broken: true }, meta: {} }),
  );
  assert.equal(response.status, 500);
});

test("HTTP boundary validates thrown API failures and preserves valid client errors", async () => {
  const request = new Request("http://localhost/api/auth/login", { method: "POST" });
  const valid = await withAccessLog(request, "trace-client", async () => {
    throw new ApiError(401, "INVALID_CREDENTIALS", "凭据无效", { remaining: 2 });
  });
  assert.equal(valid.status, 401);
  assert.deepEqual(await valid.json(), {
    traceId: "trace-client", error: { code: "INVALID_CREDENTIALS", message: "凭据无效", details: { remaining: 2 } },
  });
  for (const error of [new ApiError(401, "INVALID_CREDENTIALS", "凭据无效", "invalid-details"), new ApiError(418, "UNDECLARED", "未声明状态")]) {
    const response = await withAccessLog(request, "trace-invalid", async () => { throw error; });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  }
});

test("login route keeps origin and input rejection ahead of authentication", async () => {
  const { POST } = await import("../../../apps/web/app/api/auth/login/route.ts");
  const forbidden = await POST(new Request("https://app.example/api/auth/login", {
    method: "POST", headers: { cookie: "pstack_session=synthetic", origin: "https://evil.example" },
  }));
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "CSRF_ORIGIN_INVALID");
  assert.equal(forbidden.headers.get("set-cookie"), null);
  const invalid = await POST(new Request("https://app.example/api/auth/login", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "invalid",
  }));
  assert.equal(invalid.status, 415);
  assert.equal((await invalid.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(invalid.headers.get("set-cookie"), null);
});

test("HTTP boundary removes undeclared output fields and preserves cookies", async () => {
  const response = await withAccessLog(
    new Request("http://localhost/api/admin/users", { method: "POST" }), "trace",
    async () => Response.json({ traceId: "trace", data: { id: "user", account: "test", displayName: "Test", status: "enabled", roleIds: [], createdAt: new Date().toISOString(), passwordHash: "synthetic-secret" }, meta: {} }, { status: 201, headers: { "set-cookie": "test=value; HttpOnly" } }),
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie"), /test=value/);
  assert.equal("passwordHash" in (await response.json()).data, false);
});
