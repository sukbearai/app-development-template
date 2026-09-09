import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { advanceState, stateSchema } from "../monitor-state.mjs";
import { main, tickConfig } from "../monitor-tick.mjs";

const token = "monitor-fixture-secret-32-characters";
const env = { ...process.env, METRICS_TOKEN: token, MONITOR_WEBHOOK_TOKEN: token };
const policy = { sustainMs: 100, recoveryMs: 100, maxObservationGapMs: 1000, maxQueue: 100 };
const empty = () => ({
  version: 1,
  identity: "a".repeat(64),
  targetId: "test",
  lastObservationAt: null,
  lastTickAt: null,
  incidents: [],
  queue: [],
});
const alert = { severity: "alert", reasons: ["database_pool_waiting"] };
const healthy = { severity: "healthy", reasons: [] };
const unavailable = { severity: "error", reasons: ["metrics_http_error"] };

function snapshot(waiting) {
  const observedAt = new Date().toISOString();
  return {
    version: 1,
    observedAt,
    process: { uptimeSeconds: 1, rssBytes: 1000, heapUsedBytes: 100 },
    databasePool: { total: 1, idle: 1, waiting, max: 10 },
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
        published: 0,
        oldestPendingAgeMs: 0,
        staleLocks: 0,
      },
      tasks: {
        pending: 0,
        running: 0,
        succeeded: 0,
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

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "pstack-monitor-"));
  const received = [],
    accepted = new Set();
  const behavior = {
    waiting: 1,
    metricsStatus: 200,
    receiverStatus: 503,
    responseBody: "ok",
    hang: false,
    kill: null,
  };
  let config;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === "/api/system/metrics") {
      response.writeHead(behavior.metricsStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ traceId: "tick-fixture", data: snapshot(behavior.waiting) }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    const persisted = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
    assert.equal(persisted.queue[0].id, event.id, "persist before sending");
    assert.equal(request.headers["idempotency-key"], event.id);
    assert.equal(JSON.stringify(event).includes(token), false);
    received.push(event);
    if (behavior.receiverStatus === 200) accepted.add(event.id);
    if (behavior.kill) {
      behavior.kill.kill("SIGKILL");
      behavior.kill = null;
    }
    if (behavior.hang) return;
    response.writeHead(behavior.receiverStatus, { location: "/redirected" });
    response.end(behavior.responseBody);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  config = {
    version: 1,
    targetId: "local-proof",
    metricsUrl: `${base}/api/system/metrics`,
    webhookUrl: `${base}/alerts`,
    stateDirectory: directory,
    sustainMs: 0,
    recoveryMs: 0,
    maxObservationGapMs: 5000,
    webhookTimeoutMs: 100,
    retryBaseMs: 100,
    retryMaxMs: 100,
    maxAttempts: 5,
    maxDeliveriesPerTick: 4,
    maxQueue: 100,
    ...overrides,
  };
  const filename = path.join(directory, "config.json");
  await writeFile(filename, JSON.stringify(config));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const args = ["--config", filename];
  const tick = () => main(env, args);
  const state = async () => JSON.parse(await readFile(path.join(directory, "state.json"), "utf8"));
  const start = (extra = []) => {
    const child = spawn(process.execPath, ["scripts/monitor-tick.mjs", ...args, ...extra], {
      cwd: new URL("../../", import.meta.url),
      env,
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
    const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { child, done };
  };
  return { config, filename, args, tick, state, start, behavior, received, accepted };
}

test("sustain and recovery require observations; gaps and failures reset unconfirmed durations", () => {
  let state = advanceState(empty(), alert, policy, 1000);
  state = advanceState(state, alert, policy, 1050);
  assert.equal(state.queue.length, 0);
  state = advanceState(state, alert, policy, 2100);
  assert.deepEqual(
    state.queue.map((item) => item.reason),
    ["collection_gap"],
  );
  state = advanceState(state, alert, policy, 2200);
  assert.equal(state.queue[1].transition, "firing");
  state = advanceState(state, healthy, policy, 2250);
  state = advanceState(state, unavailable, policy, 2350);
  assert.equal(state.incidents.find((item) => item.reason === alert.reasons[0]).phase, "firing");
  state = advanceState(state, healthy, policy, 2400);
  state = advanceState(state, healthy, policy, 2500);
  assert.deepEqual(
    state.queue.filter((item) => item.reason === alert.reasons[0]).map((item) => item.transition),
    ["firing", "resolved"],
  );
  assert.throws(() => advanceState(state, healthy, policy, 2499), /clock_regressed/);
  let pending = advanceState(empty(), alert, policy, 1000);
  pending = advanceState(pending, unavailable, policy, 1100);
  pending = advanceState(pending, alert, policy, 1200);
  assert.equal(pending.queue.length, 0);
});

test("real HTTP outage survives CLI restarts, deduplicates sustained firing, and orders recovery", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.start().done).code, 1);
  const firstId = f.received[0].id;
  f.behavior.waiting = 0;
  assert.equal((await f.start().done).code, 1);
  assert.equal(f.received[1].id, firstId);
  assert.deepEqual(
    (await f.state()).queue.map((item) => item.transition),
    ["firing", "resolved"],
  );
  f.behavior.receiverStatus = 200;
  assert.equal((await f.start().done).code, 0);
  assert.deepEqual(
    f.received.slice(-2).map((item) => item.transition),
    ["firing", "resolved"],
  );
  assert.equal(f.accepted.size, 2);
  assert.equal((await f.start().done).code, 0);
  assert.equal(f.received.length, 4);
});

test("real HTTP observations retain sustain and recovery durations between processes", async (t) => {
  const f = await fixture(t, { sustainMs: 600, recoveryMs: 600 });
  f.behavior.receiverStatus = 200;
  await f.start().done;
  assert.equal(f.received.length, 0);
  await delay(650);
  await f.start().done;
  assert.equal(f.received[0].transition, "firing");
  f.behavior.waiting = 0;
  await f.start().done;
  assert.equal(f.received.length, 1);
  await delay(650);
  assert.equal((await f.start().done).code, 0);
  assert.equal(f.received[1].transition, "resolved");
});

test("kill after acceptance retains stable event key and OS lock releases for restart", async (t) => {
  const f = await fixture(t);
  f.behavior.receiverStatus = 200;
  f.behavior.hang = true;
  const running = f.start();
  f.behavior.kill = running.child;
  assert.equal((await running.done).signal, "SIGKILL");
  const id = f.received[0].id;
  assert.equal((await f.state()).queue[0].id, id);
  f.behavior.hang = false;
  assert.equal((await f.start().done).code, 1);
  assert.equal(f.received[1].id, id);
  assert.equal(f.accepted.size, 1);
  assert.equal((await f.state()).queue.length, 0);
});

test("collection failure and unavailable database cannot resolve metric incidents", async (t) => {
  const f = await fixture(t);
  f.behavior.receiverStatus = 200;
  await f.tick();
  f.behavior.metricsStatus = 503;
  await f.tick();
  assert.equal(
    (await f.state()).incidents.find((item) => item.reason === alert.reasons[0]).phase,
    "firing",
  );
  assert.equal(
    f.received.some((item) => item.transition === "resolved"),
    false,
  );
  const stale = advanceState(
    await f.state(),
    { severity: "alert", reasons: ["database_unavailable"] },
    f.config,
    Date.now(),
  );
  assert.equal(stale.incidents.find((item) => item.reason === alert.reasons[0]).phase, "firing");
});

test("duplicate invocation fails visibly; timeout and response limit retain owed event", async (t) => {
  const f = await fixture(t, { webhookTimeoutMs: 500 });
  f.behavior.hang = true;
  const first = f.tick();
  while (!f.received.length) await delay(10);
  assert.equal((await f.tick()).output.reason, "state_locked");
  await first;
  assert.equal((await f.state()).queue.length, 1);
  f.behavior.hang = false;
  f.behavior.receiverStatus = 200;
  f.behavior.responseBody = "a".repeat(20000);
  await delay(100);
  await f.tick();
  assert.equal((await f.state()).queue.length, 1);
  const beforeRedirect = f.received.length;
  f.behavior.receiverStatus = 302;
  f.behavior.responseBody = "redirect";
  await delay(100);
  await f.tick();
  assert.equal(f.received.length, beforeRedirect + 1);
  assert.equal((await f.state()).queue.length, 1);
});

test("bounded retries require explicit rearm, status detects stopped monitor, and queue never drops", async (t) => {
  const f = await fixture(t, { maxAttempts: 1, maxQueue: 1 });
  await f.tick();
  assert.equal((await f.tick()).output.deliveryExhausted, true);
  assert.equal(f.received.length, 1);
  f.behavior.waiting = 0;
  assert.equal((await f.tick()).output.reason, "queue_full");
  assert.equal((await f.state()).queue.length, 1);
  f.behavior.receiverStatus = 200;
  const beforeRetry = (await f.state()).lastTickAt;
  await main(env, [...f.args, "--retry-delivery"]);
  assert.equal((await f.state()).queue.length, 0);
  assert.equal((await f.state()).lastTickAt, beforeRetry);
  assert.equal((await f.tick()).exitCode, 0);
  const state = await f.state();
  state.lastTickAt = Date.now() - 6000;
  await writeFile(path.join(f.config.stateDirectory, "state.json"), JSON.stringify(state));
  assert.equal((await main(env, [...f.args, "--status"])).output.heartbeatStale, true);
  assert.equal((await main(env, ["--status", ...f.args])).output.heartbeatStale, true);
  assert.equal((await main(env, ["--status", ...f.args, "--retry-delivery"])).exitCode, 2);
});

test("strict config/state reject corruption, identity changes and unknown fields without leaking secrets", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const state = await f.state();
  assert.equal(JSON.stringify(state).includes(token), false);
  await writeFile(path.join(f.config.stateDirectory, "state.json"), "broken secret");
  assert.equal((await f.tick()).output.reason, "invalid_state");
  assert.equal(f.received.length, 1);
  assert.throws(() => stateSchema.parse({ ...state, unknown: true }));
  state.identity = "b".repeat(64);
  await writeFile(path.join(f.config.stateDirectory, "state.json"), JSON.stringify(state));
  assert.equal((await f.tick()).output.reason, "invalid_state");
  for (const patch of [
    { unexpected: true },
    { webhookUrl: "http://outside.example/hook" },
    { maxAttempts: 0 },
    { webhookUrl: "https://alerts.example/hook?token=secret" },
  ]) {
    await writeFile(f.filename, JSON.stringify({ ...f.config, ...patch }));
    await assert.rejects(() => tickConfig(f.filename, env));
  }
});
