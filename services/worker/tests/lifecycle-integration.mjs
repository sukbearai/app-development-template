import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kafka, logLevel } from "kafkajs";
import { randomUUID } from "node:crypto";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(description, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error(`Timed out: ${description}`);
}
async function readHeartbeat(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function launch(args, env) {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    result;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      result = { code, signal };
      resolve(result);
    });
  });
  return {
    child,
    exited,
    get result() {
      return result;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
async function runtime(t, overrides = {}, fixture, command = "outbox-loop") {
  const directory = await mkdtemp(join(tmpdir(), "worker-lifecycle-"));
  const heartbeat = join(directory, "heartbeat.json");
  const applicationName = `lifecycle-${randomUUID()}`;
  const database = new URL(process.env.WORKER_TEST_DATABASE_URL);
  database.searchParams.set("application_name", applicationName);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
    DATABASE_URL: database.toString(),
    OUTBOX_PUBLISHER: "dry-run",
    OUTBOX_DRY_RUN: "1",
    WORKER_HEARTBEAT_PATH: heartbeat,
    WORKER_SHUTDOWN_TIMEOUT_MS: "3000",
    ...overrides,
  };
  const entrypoint = new URL("../src/index.ts", import.meta.url).pathname;
  const args = fixture
    ? [new URL("./fixtures/lifecycle-owner.mjs", import.meta.url).pathname, fixture]
    : [entrypoint, command, "--interval-ms", "25"];
  const worker = launch(args, env);
  t.after(async () => {
    if (!worker.result) worker.child.kill("SIGKILL");
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  });
  return Object.assign(worker, {
    heartbeat,
    applicationName,
    async health() {
      const probe = launch([entrypoint, "health", "--live"], env);
      const timer = setTimeout(() => probe.child.kill("SIGKILL"), 5000);
      try {
        const result = await probe.exited;
        return { ...result, ...JSON.parse(probe.stdout) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
async function blocked(pool, worker) {
  const result = await pool.query(
    "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
    [worker.applicationName],
  );
  return result.rows.length > 0;
}
async function lockTable(pool, t, table) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  t.after(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  return client;
}

export function registerWorkerLifecycleTests(pool) {
  test(
    "lifecycle reports a real consumer SQL failure after SIGTERM",
    { timeout: 20000 },
    async (t) => {
      const topic = `drain-failure-${randomUUID()}`;
      const worker = await runtime(
        t,
        {
          OUTBOX_PUBLISHER: "kafka",
          OUTBOX_DRY_RUN: "0",
          KAFKA_BROKERS: process.env.WORKER_TEST_KAFKA_BROKERS,
          ASYNC_RUNTIME_TOPICS: topic,
          KAFKA_CONSUMER_GROUP_ID: topic,
          WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
        },
        undefined,
        "async-runtime",
      );
      await waitFor("consumer ready", () => worker.stdout.includes('"iteration":1'));
      const lock = await lockTable(pool, t, "app_message_quarantine");
      const producer = new Kafka({
        brokers: process.env.WORKER_TEST_KAFKA_BROKERS.split(","),
        logLevel: logLevel.NOTHING,
      }).producer();
      t.after(() => producer.disconnect());
      await producer.connect();
      await producer.send({ topic, messages: [{ value: "invalid-json" }] });
      let backend;
      await waitFor("accepted quarantine INSERT blocked", async () => {
        backend = (
          await pool.query(
            `SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
         AND query LIKE 'INSERT INTO "app_message_quarantine"%'`,
            [worker.applicationName],
          )
        ).rows[0];
        return backend !== undefined;
      });
      worker.child.kill("SIGTERM");
      await waitFor(
        "drain starts",
        async () => (await readHeartbeat(worker.heartbeat))?.state === "stopping",
      );
      await pause(100);
      assert.equal(worker.result, undefined);
      assert.equal(
        (await pool.query("SELECT pg_cancel_backend($1) cancelled", [backend.pid])).rows[0]
          .cancelled,
        true,
      );
      await lock.query("ROLLBACK");
      await waitFor("failed consumer drain exits", () => worker.result !== undefined);
      const heartbeat = await readHeartbeat(worker.heartbeat);
      t.diagnostic(
        JSON.stringify({
          injected: "pg_cancel_backend of accepted quarantine INSERT after SIGTERM",
          exit: worker.result,
          heartbeat: heartbeat.state,
        }),
      );
      assert.deepEqual(await worker.exited, { code: 1, signal: null }, worker.stderr);
      assert.equal(heartbeat.state, "failed");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1",
            [worker.applicationName],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  test(
    "lifecycle startup remains unhealthy, then repeated SIGTERM drains accepted SQL",
    { timeout: 20000 },
    async (t) => {
      const startupLock = await lockTable(pool, t, "app_kafka_recovery");
      const worker = await runtime(t);
      await waitFor("startup query lock", () => blocked(pool, worker));
      await pause(3200);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "starting");
      assert.equal(worker.stdout.includes('"iteration":'), false);
      const startingHealth = await worker.health();
      assert.equal(startingHealth.code, 1);
      assert.equal(startingHealth.status, "degraded");
      assert.equal(startingHealth.state, "starting");
      await startupLock.query("ROLLBACK");
      await waitFor("first completed iteration", () => worker.stdout.includes('"iteration":1'));
      assert.equal((await worker.health()).status, "ok");
      const queryLock = await lockTable(pool, t, "app_outbox_events");
      await waitFor("accepted outbox query", () => blocked(pool, worker));
      worker.child.kill("SIGTERM");
      await waitFor(
        "stopping heartbeat",
        async () => (await readHeartbeat(worker.heartbeat))?.state === "stopping",
      );
      worker.child.kill("SIGTERM");
      await pause(100);
      assert.equal(worker.result, undefined, worker.stderr);
      assert.equal((await worker.health()).status, "degraded");
      await queryLock.query("ROLLBACK");
      await waitFor("clean process exit", () => worker.result !== undefined);
      assert.deepEqual(await worker.exited, { code: 0, signal: null }, worker.stderr);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "stopped");
    },
  );

  test(
    "lifecycle stops during startup without beginning an iteration",
    { timeout: 10000 },
    async (t) => {
      const lock = await lockTable(pool, t, "app_kafka_recovery");
      const worker = await runtime(t);
      await waitFor("startup lock", () => blocked(pool, worker));
      worker.child.kill("SIGTERM");
      await waitFor(
        "startup stopping",
        async () => (await readHeartbeat(worker.heartbeat))?.state === "stopping",
      );
      worker.child.kill("SIGTERM");
      await lock.query("ROLLBACK");
      await waitFor("startup cancellation exit", () => worker.result !== undefined);
      assert.deepEqual(await worker.exited, { code: 0, signal: null });
      assert.equal(worker.stdout.includes('"iteration":'), false);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "stopped");
    },
  );

  test(
    "lifecycle waits for Kafka group join even when run resolves",
    { timeout: 15000 },
    async (t) => {
      const worker = await runtime(
        t,
        {
          ASYNC_RUNTIME_TOPICS: `readiness-${randomUUID()}`,
          KAFKA_CONSUMER_GROUP_ID: `readiness-${randomUUID()}`,
        },
        "consumer-no-join",
      );
      await waitFor("consumer run returned", () =>
        worker.stdout.includes("run returned without group join"),
      );
      await pause(3200);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "starting");
      assert.equal(worker.stdout.includes('"iteration":'), false);
      worker.child.kill("SIGTERM");
      await waitFor("unjoined consumer cleanup", () => worker.result !== undefined);
      assert.deepEqual(await worker.exited, { code: 0, signal: null }, worker.stderr);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "stopped");
    },
  );

  test(
    "lifecycle finite completion cleans up and exits without a signal",
    { timeout: 10000 },
    async (t) => {
      const worker = await runtime(t, {}, "finite-clean");
      await waitFor("finite process exit", () => worker.result !== undefined);
      assert.deepEqual(await worker.exited, { code: 0, signal: null });
      assert.match(worker.stdout, /"iteration":1/);
      assert.equal((await readHeartbeat(worker.heartbeat)).state, "stopped");
    },
  );

  for (const table of ["app_kafka_recovery", "app_outbox_events"]) {
    test(
      `lifecycle deadline bounds ${table} lock and repeated signals`,
      { timeout: 15000 },
      async (t) => {
        await lockTable(pool, t, table);
        const worker = await runtime(t, { WORKER_SHUTDOWN_TIMEOUT_MS: "700" });
        await waitFor("blocked SQL", () => blocked(pool, worker));
        const started = Date.now();
        worker.child.kill("SIGINT");
        await waitFor(
          "stopping heartbeat",
          async () => (await readHeartbeat(worker.heartbeat))?.state === "stopping",
        );
        await pause(350);
        worker.child.kill("SIGINT");
        await waitFor("deadline exit", () => worker.result !== undefined, 2500);
        const elapsed = Date.now() - started;
        assert.deepEqual(await worker.exited, { code: 1, signal: null }, worker.stderr);
        assert.ok(
          elapsed >= 600 && elapsed < 1000,
          `deadline was bypassed or reset: ${elapsed} ms`,
        );
        assert.equal((await readHeartbeat(worker.heartbeat)).state, "stopping");
        assert.match(worker.stderr, /worker shutdown deadline exceeded/);
        t.diagnostic(
          JSON.stringify({ table, elapsedMs: elapsed, exit: worker.result, heartbeat: "stopping" }),
        );
      },
    );
  }

  for (const mode of [
    "cleanup-hang",
    "falsy-hang",
    "cleanup-failure",
    "falsy-failure",
    "cleanup-reject-live",
    "connect-reject-hang",
  ]) {
    test(`lifecycle actual owner handles ${mode}`, { timeout: 10000 }, async (t) => {
      const worker = await runtime(t, { WORKER_SHUTDOWN_TIMEOUT_MS: "700" }, mode);
      await waitFor("owner exit", () => worker.result !== undefined, 5000);
      assert.deepEqual(await worker.exited, { code: 1, signal: null }, worker.stderr);
      const heartbeat = await readHeartbeat(worker.heartbeat);
      if (mode.endsWith("hang")) {
        assert.equal(heartbeat.state, "stopping");
        assert.match(worker.stderr, /worker shutdown deadline exceeded/);
        if (mode === "cleanup-hang") assert.match(worker.stdout, /"iteration":1/);
        if (mode === "connect-reject-hang") {
          assert.match(worker.stdout, /connect rejected\ndisconnect pending/);
          assert.equal(worker.stdout.includes('"iteration":'), false);
        }
      } else if (mode === "cleanup-reject-live") {
        assert.equal(heartbeat.state, "failed");
        assert.match(worker.stderr, /worker shutdown deadline exceeded/);
        assert.match(worker.stdout, /"errorCount":1/);
      } else {
        assert.equal(heartbeat.state, "failed");
        const error = JSON.parse(worker.stdout.trim());
        assert.equal(error.errorCount, mode === "cleanup-failure" ? 2 : 1);
        assert.equal(error.undefinedFailure, mode === "falsy-failure");
      }
      t.diagnostic(JSON.stringify({ mode, exit: worker.result, heartbeat: heartbeat.state }));
    });
  }
}
