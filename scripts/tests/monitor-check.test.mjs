import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { checkMonitor, evaluateMetrics, main, monitorConfig } from "../monitor-check.mjs";

const token = "monitor-test-secret-credential-32";
const baseEnv = { METRICS_URL: "http://127.0.0.1/api/system/metrics", METRICS_TOKEN: token };
const now = Date.now();
function snapshot() {
  const observedAt = new Date(now).toISOString();
  return {
    version: 1,
    observedAt,
    process: { uptimeSeconds: 10, rssBytes: 10000, heapUsedBytes: 1000 },
    databasePool: { total: 1, idle: 1, waiting: 0, max: 10 },
    uploads: { active: 0, limit: 4, rejectedTotal: 0 },
    http: [],
    database: {
      status: "available",
      observedAt,
      outbox: {
        pending: 0,
        processing: 0,
        failed: 0,
        deadLetter: 0,
        published: 1,
        oldestPendingAgeMs: 0,
        staleLocks: 0,
      },
      tasks: {
        pending: 0,
        running: 0,
        succeeded: 1,
        failed: 0,
        deadLetter: 0,
        canceled: 0,
        oldestUnfinishedAgeMs: 0,
      },
      quarantine: { message: 0, recovery: 0 },
      uploads: { pending: 0, writing: 0, cleanup: 0, blocked: 0 },
    },
  };
}
async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    ...baseEnv,
    METRICS_URL: `http://127.0.0.1:${server.address().port}/api/system/metrics`,
  };
}
function respond(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ traceId: "monitor-test-trace", data: value, meta: {} }));
}
function assertSafe(output) {
  const serialized = JSON.stringify(output);
  for (const secret of [token, "postgres://", "user:password", "private-error", "http://"]) {
    assert.equal(serialized.includes(secret), false);
  }
}

test("configuration accepts HTTPS and local HTTP and rejects unsafe or malformed options", () => {
  for (const url of [
    baseEnv.METRICS_URL,
    "https://metrics.example/api/system/metrics",
    "http://[::1]/api/system/metrics",
  ]) {
    assert.equal(monitorConfig({ ...baseEnv, METRICS_URL: url }).url.href, url);
  }
  const invalid = [
    { METRICS_URL: "http://metrics.example/api/system/metrics" },
    { METRICS_URL: "https://user:password@example.com/api/system/metrics" },
    { METRICS_URL: "https://example.com/api/system/metrics?token=private-error" },
    { METRICS_URL: "https://example.com/api/system/metrics#private-error" },
    { METRICS_URL: "https://example.com/api/other" },
    { METRICS_URL: "file:///api/system/metrics" },
    { METRICS_URL: "" },
    { METRICS_TOKEN: "" },
    { METRICS_TOKEN: "x".repeat(31) },
    { METRICS_TOKEN: "x".repeat(257) },
    { METRICS_TOKEN: "x".repeat(32) + "+" },
    { METRICS_TOKEN: "secret\r\ninjected: header" },
    { MONITOR_TIMEOUT_MS: "99" },
    { MONITOR_TIMEOUT_MS: "60001" },
    { MONITOR_MAX_AGE_MS: "Infinity" },
    { MONITOR_POOL_WAITING: "-1" },
    { MONITOR_TASK_AGE_MS: "0" },
    { MONITOR_DEAD_LETTERS: "1.5" },
    { MONITOR_OUTBOX_STALE_LOCKS: "0" },
    { MONITOR_OUTBOX_STALE_LOCKS: "1000000001" },
    { MONITOR_QUARANTINE: "1e3" },
    { MONITOR_BLOCKED_UPLOADS: "1000000001" },
  ];
  for (const overrides of invalid) assert.throws(() => monitorConfig({ ...baseEnv, ...overrides }));
  assert.throws(() => monitorConfig(baseEnv, ["--unknown"]));
});

test("thresholds are inclusive, configurable, and cover queue age and durable exceptions", () => {
  const metrics = snapshot();
  const config = monitorConfig(baseEnv);
  assert.deepEqual(evaluateMetrics(metrics, config, now), {
    version: 1,
    severity: "healthy",
    reasons: [],
  });
  metrics.databasePool.waiting = config.poolWaiting;
  metrics.database.outbox.oldestPendingAgeMs = config.outboxAgeMs;
  metrics.database.tasks.oldestUnfinishedAgeMs = config.taskAgeMs;
  metrics.database.tasks.deadLetter = config.deadLetters;
  metrics.database.quarantine.recovery = config.quarantine;
  metrics.database.uploads.blocked = config.blockedUploads;
  assert.deepEqual(evaluateMetrics(metrics, config, now).reasons, [
    "database_pool_waiting",
    "outbox_pending_age",
    "task_unfinished_age",
    "dead_letters",
    "quarantine",
    "uploads_blocked",
  ]);
  const relaxed = monitorConfig({
    ...baseEnv,
    MONITOR_POOL_WAITING: "2",
    MONITOR_OUTBOX_AGE_MS: "300001",
    MONITOR_TASK_AGE_MS: "900001",
    MONITOR_DEAD_LETTERS: "2",
    MONITOR_QUARANTINE: "2",
    MONITOR_BLOCKED_UPLOADS: "2",
  });
  assert.equal(evaluateMetrics(metrics, relaxed, now).severity, "healthy");
});

test("processing-only outbox reports expired leases while live leases stay healthy", async (t) => {
  const metrics = snapshot();
  metrics.database.outbox.processing = 1;
  const env = await serve(t, (_request, response) => respond(response, metrics));
  assert.equal((await main(env, [])).output.severity, "healthy");
  metrics.database.outbox.staleLocks = 1;
  const { output, exitCode } = await main(env, []);
  assert.equal(exitCode, 1);
  assert.deepEqual(output.reasons, ["outbox_stale_locks"]);
  assert.equal(
    (await main({ ...env, MONITOR_OUTBOX_STALE_LOCKS: "2" }, [])).output.severity,
    "healthy",
  );
});

test("stale, future, and unavailable database observations cannot pass as healthy", () => {
  const config = monitorConfig(baseEnv);
  for (const [offset, expected] of [
    [-60001, ["metrics_stale", "database_metrics_stale"]],
    [5001, ["metrics_clock_ahead", "database_metrics_clock_ahead"]],
  ]) {
    const metrics = snapshot();
    metrics.observedAt = metrics.database.observedAt = new Date(now + offset).toISOString();
    assert.deepEqual(evaluateMetrics(metrics, config, now).reasons, expected);
  }
  const metrics = snapshot();
  metrics.database = { status: "unavailable", observedAt: metrics.observedAt };
  assert.deepEqual(evaluateMetrics(metrics, config, now).reasons, ["database_unavailable"]);
});

test("GET sends bearer authentication and validates the real response", async (t) => {
  const env = await serve(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/system/metrics");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    respond(response, snapshot());
  });
  assert.deepEqual(await main(env, []), {
    output: { version: 1, severity: "healthy", reasons: [] },
    exitCode: 0,
  });
});

test("HTTP snapshots with stale or unavailable database observations exit with an alert", async (t) => {
  for (const unavailable of [false, true]) {
    await t.test(String(unavailable), async (subtest) => {
      const metrics = snapshot();
      if (unavailable) metrics.database = { status: "unavailable", observedAt: metrics.observedAt };
      else metrics.database.observedAt = new Date(now - 120000).toISOString();
      const env = await serve(subtest, (_request, response) => respond(response, metrics));
      const { output, exitCode } = await main(env, []);
      assert.equal(exitCode, 1);
      assert.deepEqual(output.reasons, [
        unavailable ? "database_unavailable" : "database_metrics_stale",
      ]);
    });
  }
});

test("redirect is rejected without a second credential-bearing request", async (t) => {
  let requests = 0;
  const env = await serve(t, (_request, response) => {
    requests++;
    response.writeHead(302, { location: "/private-error" });
    response.end(token);
  });
  const output = await checkMonitor(monitorConfig(env));
  assert.deepEqual(output.reasons, ["metrics_request_failed"]);
  assert.equal(requests, 1);
  assertSafe(output);
});

test("malformed, wrong schema, wrong media type, HTTP failure, and oversized streams are secret-free failures", async (t) => {
  const cases = [
    [200, "application/json", "{private-error", "metrics_invalid_response"],
    [200, "application/json", JSON.stringify({ error: token }), "metrics_invalid_response"],
    [200, "text/html", token, "metrics_invalid_response"],
    [200, "application/json", JSON.stringify(snapshot()), "metrics_invalid_response"],
    [
      503,
      "application/json",
      JSON.stringify({ error: `postgres://user:password private-error ${token}` }),
      "metrics_http_error",
    ],
    [
      200,
      "application/json",
      " ".repeat(256 * 1024) + JSON.stringify(snapshot()),
      "metrics_invalid_response",
    ],
  ];
  for (const [status, mediaType, body, reason] of cases) {
    await t.test(reason + status + mediaType + body.length, async (subtest) => {
      const env = await serve(subtest, (_request, response) => {
        response.writeHead(status, { "content-type": mediaType });
        response.write(body.slice(0, 1024));
        response.end(body.slice(1024));
      });
      const { output, exitCode } = await main(env, []);
      assert.equal(exitCode, 1);
      assert.deepEqual(output.reasons, [reason]);
      assertSafe(output);
    });
  }
});

test("timeout bounds headers and response body", async (t) => {
  for (const sendHeaders of [false, true]) {
    await t.test(String(sendHeaders), async (subtest) => {
      const env = await serve(subtest, (_request, response) => {
        if (sendHeaders) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
        }
      });
      const output = await checkMonitor(monitorConfig({ ...env, MONITOR_TIMEOUT_MS: "100" }));
      assert.deepEqual(output.reasons, ["metrics_timeout"]);
      assertSafe(output);
    });
  }
});

test("CLI returns JSON and exit 2 for invalid configuration without exposing input", async () => {
  const child = spawn(process.execPath, ["scripts/monitor-check.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, METRICS_URL: "private-error", METRICS_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [exitCode] = await once(child, "close");
  assert.equal(exitCode, 2);
  assertSafe(stderr);
  assert.deepEqual(JSON.parse(stdout), {
    version: 1,
    severity: "error",
    reasons: ["invalid_configuration"],
  });
  assertSafe(stdout);
});
