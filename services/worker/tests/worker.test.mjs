import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  asyncTaskIdempotencyKey,
  failAsyncTask,
  nextKafkaOffset,
  parseAsyncTaskMessage,
  payloadHash,
  processAsyncConsumerMessage,
  processConsumerMessagesSequentially,
} from "../src/async-consumer.ts";
import { buildAsyncRuntimePlan } from "../src/async-runtime.ts";
import { outboxKafkaMessageValue, publishOutboxOnce, workerHealth } from "../src/index.ts";
import { log, redact } from "../src/logger.ts";
import { buildOutboxAlerts, outboxReadinessStatus } from "../src/outbox-readiness.ts";
import { asyncRuntimeTopics } from "../src/env.ts";
import { outboxKafkaMessageKey, processOutboxOnce } from "../src/outbox.ts";

process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES = "1";

test("production worker requires an explicit publisher while diagnostics remain available", async () => {
  const { loadWorkerEnv } = await import("../src/env.ts");
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OUTBOX_PUBLISHER: process.env.OUTBOX_PUBLISHER,
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.OUTBOX_PUBLISHER;
    assert.throws(() => loadWorkerEnv(), /OUTBOX_PUBLISHER is required in production/);
    assert.equal(loadWorkerEnv({ allowMissingPublisher: true }).outboxPublisher, "dry-run");
    process.env.OUTBOX_PUBLISHER = "dry-run";
    assert.equal(loadWorkerEnv().outboxPublisher, "dry-run");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("production health and runtime plans do not require a publisher or database", () => {
  const env = { ...process.env, NODE_ENV: "production", APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1" };
  delete env.OUTBOX_PUBLISHER;
  delete env.DATABASE_URL;
  for (const args of [
    ["health"],
    ["async-runtime", "--iterations", "0"],
    ["outbox-loop", "--iterations", "0"],
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        new URL("../src/index.ts", import.meta.url).pathname,
        ...args,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(JSON.parse(child.stdout));
  }
  const runtime = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      new URL("../src/index.ts", import.meta.url).pathname,
      "async-runtime",
      "--iterations",
      "1",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(runtime.status, 1);
  assert.match(runtime.stdout + runtime.stderr, /OUTBOX_PUBLISHER is required in production/);
});

test("explicit production outbox dry-run reads without claiming or connecting Kafka", async () => {
  const { processOutboxOnce } = await import("../src/outbox.ts");
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    OUTBOX_PUBLISHER: process.env.OUTBOX_PUBLISHER,
  };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.OUTBOX_PUBLISHER;
    const statements = [];
    const result = await processOutboxOnce({
      dryRun: true,
      pool: {
        query: async (sql) => {
          statements.push(sql);
          return { rows: [] };
        },
      },
    });
    assert.equal(result.inspected, 0);
    assert.equal(statements.length, 1);
    assert.match(statements[0].trim(), /^SELECT/);
    assert.doesNotMatch(statements[0], /FOR UPDATE|UPDATE |INSERT |DELETE /);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const stopAt of ["connection", "claim", "none"]) {
  test(`outbox stop boundary: ${stopAt}`, { timeout: 5000 }, async () => {
    const controller = new AbortController();
    const connecting = Promise.withResolvers();
    const connected = Promise.withResolvers();
    const counts = { claims: 0, sends: 0, acknowledgements: 0, releases: 0 };
    const client = {
      async query(sql) {
        assert.match(sql, /WITH next_events/);
        counts.claims++;
        if (stopAt === "claim") controller.abort();
        return {
          rows: [
            {
              id: "stop-boundary",
              topic: "app.tasks",
              event_type: "demo.echo",
              trace_id: "stop-boundary",
              payload: {},
              attempts: 1,
              max_attempts: 5,
              lease_generation: 1,
            },
          ],
        };
      },
      release() {
        counts.releases++;
      },
    };
    const pool = {
      async query(sql) {
        if (sql.includes("to_regnamespace")) return { rows: [{ guard: null }] };
        if (sql.includes("FROM app_kafka_recovery")) return { rows: [] };
        assert.match(sql, /SET status = 'published'/);
        counts.acknowledgements++;
        return { rows: [{ id: "stop-boundary" }] };
      },
      async connect() {
        connecting.resolve();
        await connected.promise;
        return client;
      },
    };
    const producer = {
      async send() {
        counts.sends++;
      },
    };
    const pending = processOutboxOnce({
      pool,
      producer,
      signal: controller.signal,
      dryRun: false,
      batchSize: stopAt === "claim" ? 2 : 1,
    });
    await connecting.promise;
    assert.equal(counts.claims, 0);
    if (stopAt === "connection") controller.abort();
    connected.resolve();
    const result = await pending;
    const expected = stopAt === "connection" ? 0 : 1;
    assert.deepEqual(counts, {
      claims: expected,
      sends: expected,
      acknowledgements: expected,
      releases: 1,
    });
    assert.equal(result.claimed, expected);
    assert.equal(result.published, expected);
  });
}

test("payload identity is independent of Unicode key order at every depth", () => {
  const first = {
    taskType: "demo.echo",
    payload: { items: [{ "e\u0301": 2, "\u00e9": 1 }], z: true },
  };
  const reordered = {
    taskType: "demo.echo",
    payload: { z: true, items: [{ "\u00e9": 1, "e\u0301": 2 }] },
  };
  assert.deepEqual(first, reordered);
  assert.equal(payloadHash(first), payloadHash(reordered));
  assert.notEqual(
    payloadHash(first),
    payloadHash({ ...first, payload: { items: [{ "e\u0301": 1, "\u00e9": 2 }], z: true } }),
  );
  assert.notEqual(payloadHash(first), payloadHash({ ...first, taskType: "file.uploaded" }));
});

test("v2 payload hash has a fixed UTF-16 vector across process locales", () => {
  const task = {
    taskType: "demo.echo",
    payload: { 2: 2, 10: 10, a: 2, A: 1, é: 4, "e\u0301": 3, "😀": [1, 2], "\ue000": 5 },
  };
  const expected = "v2:2b029f5217a2a866434d28b9fed839960e520c9b4219e9d1315e4b2ff5815747";
  assert.equal(payloadHash(task), expected);
  assert.notEqual(payloadHash({ ...task, payload: { ...task.payload, "😀": [2, 1] } }), expected);
  assert.notEqual(
    payloadHash({ taskType: "demo.echo", payload: { é: 1 } }),
    payloadHash({ taskType: "demo.echo", payload: { "e\u0301": 1 } }),
  );
  const locales = [];
  for (const locale of ["en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"]) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `import { payloadHash } from ${JSON.stringify(new URL("../src/async-consumer.ts", import.meta.url).href)}; process.stdout.write(JSON.stringify({ hash: payloadHash(${JSON.stringify(task)}), locale: Intl.DateTimeFormat().resolvedOptions().locale }));`,
      ],
      { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.hash, expected);
    locales.push(result.locale);
  }
  assert.equal(new Set(locales).size, 3);
});

test("worker health returns ok", () => {
  assert.equal(workerHealth().status, "ok");
  assert.ok(workerHealth().supportedCommands.includes("async-runtime"));
});

test("buildAsyncRuntimePlan exposes outbox, kafka, and async task defaults", () => {
  const plan = buildAsyncRuntimePlan(["--interval-ms", "2500"], {
    ASYNC_RUNTIME_TOPICS: "app.tasks,app.other",
    OUTBOX_PUBLISHER: "kafka",
    KAFKA_BROKERS: "localhost:9092,localhost:9093",
    KAFKA_CLIENT_ID: "test-worker",
    KAFKA_CONSUMER_GROUP_ID: "test-consumer",
    ASYNC_TASK_DEFAULT_MAX_ATTEMPTS: "7",
    ASYNC_TASK_RETRY_BASE_MS: "2000",
    ASYNC_TASK_RETRY_MAX_MS: "4000",
    ASYNC_TASK_IDEMPOTENCY_TTL_HOURS: "24",
  });

  assert.equal(plan.outboxIntervalMs, 2500);
  assert.deepEqual(plan.topics, ["app.tasks", "app.other"]);
  assert.equal(plan.publisher, "kafka");
  assert.deepEqual(plan.kafka, {
    brokersConfigured: 2,
    clientId: "test-worker",
    consumerGroupId: "test-consumer",
  });
  assert.deepEqual(plan.asyncTask, {
    defaultMaxAttempts: 7,
    retryBaseMs: 2000,
    retryMaxMs: 4000,
    idempotencyTtlHours: 24,
  });
  assert.deepEqual(asyncRuntimeTopics({}), [
    "app.tasks",
    "telemetry.events",
    "files.events",
    "audit.events",
  ]);
});

test("publishOutboxOnce requires DATABASE_URL", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await assert.rejects(() => publishOutboxOnce(), /DATABASE_URL is required/);
  if (previous) process.env.DATABASE_URL = previous;
});

test("worker logger redacts sensitive fields recursively", () => {
  assert.deepEqual(redact({ token: "secret", nested: { accessKey: "key", ok: true } }), {
    token: "[REDACTED]",
    nested: { accessKey: "[REDACTED]", ok: true },
  });
});

function loggedError(t, error) {
  let line;
  t.mock.method(console, "error", (value) => {
    line = value;
  });
  log("error", "Worker command failed", { error });
  return JSON.parse(line).error;
}

test("worker logger retains recovery reasons and cleanup siblings inside nested aggregates", (t) => {
  const recovery = new AggregateError(
    [
      new Error("Application restore is incomplete; worker startup is blocked"),
      new Error("Kafka recovery is incomplete; worker startup is blocked"),
      new Error('Kafka recovery transport offset missing or reset: ["private-topic",0]'),
      new Error('Kafka recovery history unavailable: ["private-topic",0] next=1 low=2 high=3'),
    ],
    "Kafka recovery initialization and cleanup failed",
  );
  const result = loggedError(
    t,
    new AggregateError([recovery, new Error("cleanup password=hidden")], "Worker runtime failed"),
  );
  assert.equal(result.message, "Worker runtime failed");
  for (const reason of [
    "Application restore is incomplete",
    "recovery is incomplete",
    "offset missing or reset",
    "history unavailable",
  ]) {
    assert.ok(JSON.stringify(result.diagnostics).includes(reason), reason);
  }
  assert.equal(result.diagnostics.filter((item) => item.path === "errors[1]").length, 1);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /hidden|private-topic|next=|stack/);
});

test("worker logger bounds nested diagnostics and never includes nested secrets or sensitive paths", (t) => {
  const error = new Error(
    "connect postgres://user:password@host/db token=secret /private/credentials",
  );
  error.name = "SECRET_NAME";
  error.stack = "/private/secret-stack";
  error.password = "FIELD_SECRET";
  const nested = new Error("wrapper", { cause: error });
  const result = loggedError(
    t,
    new AggregateError(
      [nested, { secret: "VALUE_SECRET" }, false, 0, null, undefined],
      "Worker runtime failed",
    ),
  );
  assert.equal(result.diagnostics.length, 7);
  assert.doesNotMatch(
    JSON.stringify(result.diagnostics),
    /postgres|password|token|secret|SECRET|private|credentials|wrapper/,
  );
  assert.equal(
    result.diagnostics.filter((item) => item.message === "Non-Error thrown value").length,
    5,
  );
});

test("worker logger does not invoke nested error accessors", (t) => {
  let calls = 0;
  const getter = () => {
    calls++;
    throw new Error("secret accessor");
  };
  const hostile = new AggregateError([], "message");
  for (const property of ["message", "cause", "errors"]) {
    Object.defineProperty(hostile, property, { get: getter, enumerable: true });
  }
  const accessorEntry = new AggregateError([], "Kafka consumer failed");
  Object.defineProperty(accessorEntry.errors, "0", { get: getter });
  const invalidMembers = new AggregateError([], "Kafka consumer failed");
  invalidMembers.errors = { secret: "must not traverse" };
  const result = loggedError(
    t,
    new AggregateError([hostile, accessorEntry, invalidMembers], "Worker runtime failed"),
  );
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /secret|accessor|must not traverse/);
});

test("worker logger handles cycles, falsy causes, and diagnostic depth and size limits", (t) => {
  const cyclic = new Error("cyclic");
  cyclic.cause = cyclic;
  assert.match(JSON.stringify(loggedError(t, cyclic).diagnostics), /Circular error reference/);
  for (const cause of [false, 0, null, undefined]) {
    assert.equal(
      loggedError(t, new Error("wrapper", { cause })).diagnostics[0].message,
      "Non-Error thrown value",
    );
  }
  let deep = new Error("bottom secret");
  for (let i = 0; i < 100; i++) deep = new Error("wrapper secret", { cause: deep });
  const depthResult = loggedError(t, new AggregateError([deep], "Worker runtime failed"));
  assert.match(JSON.stringify(depthResult.diagnostics), /Error diagnostics truncated/);
  assert.ok(depthResult.diagnostics.length <= 17);
  const wide = loggedError(
    t,
    new AggregateError(
      Array.from({ length: 1000 }, () => new Error("secret")),
      "Worker runtime failed",
    ),
  );
  assert.ok(wide.diagnostics.length <= 17);
  assert.match(JSON.stringify(wide.diagnostics), /Error diagnostics truncated/);
  assert.ok(JSON.stringify(wide.diagnostics).length < 4096);
});

test("outbox Kafka message values use async task envelope fields", () => {
  const plain = JSON.parse(
    outboxKafkaMessageValue(
      {
        id: "evt_plain",
        topic: "tests",
        event_type: "test.created",
        trace_id: "trace-plain",
        payload: { ok: true },
        attempts: 0,
      },
      "2026-01-01T00:00:00.000Z",
    ),
  );
  assert.deepEqual(plain, {
    eventId: "evt_plain",
    eventType: "test.created",
    traceId: "trace-plain",
    payload: { ok: true },
    attempts: 0,
    occurredAt: "2026-01-01T00:00:00.000Z",
  });

  const asyncPayload = JSON.parse(
    outboxKafkaMessageValue(
      {
        id: "evt_async",
        topic: "tests",
        event_type: "test.async",
        trace_id: "trace-fallback",
        payload: {
          eventId: "evt_async",
          eventType: "test.async",
          traceId: "trace-async",
          taskId: "task-1",
          idempotencyKey: "idem-1",
          payload: { jobId: "job-1" },
        },
        attempts: 1,
      },
      "2026-01-01T00:00:00.000Z",
    ),
  );
  assert.deepEqual(asyncPayload, {
    eventId: "evt_async",
    eventType: "test.async",
    traceId: "trace-async",
    taskId: "task-1",
    idempotencyKey: "idem-1",
    payload: { jobId: "job-1" },
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
});

test("outbox Kafka message key groups by trace", () => {
  assert.equal(
    outboxKafkaMessageKey({
      id: "evt_key",
      topic: "tests",
      eventType: "test.created",
      traceId: "trace-key",
      payload: {},
      attempts: 0,
      maxAttempts: 5,
    }),
    "trace-key",
  );
});

test("outbox readiness classifies backlog and alerts", () => {
  const base = {
    pending: 0,
    failed: 0,
    deadLetter: 0,
    staleLocks: 0,
    oldestPendingAgeMs: 0,
    quarantine: { messageQuarantine: 0, recoveryQuarantine: 0 },
    pendingWarn: 50,
    pendingBlocked: 200,
    failedWarn: 10,
  };
  assert.equal(outboxReadinessStatus(base), "ok");
  assert.equal(outboxReadinessStatus({ ...base, pending: 50 }), "degraded");
  assert.equal(outboxReadinessStatus({ ...base, pending: 200 }), "blocked");
  assert.equal(outboxReadinessStatus({ ...base, deadLetter: 1 }), "blocked");
  assert.deepEqual(
    buildOutboxAlerts({ ...base, staleLocks: 1 }).map((alert) => alert.reason),
    ["outbox_stale_processing_lock"],
  );
});

test("outbox readiness uses shared backlog boundary decisions and custom thresholds", () => {
  const base = {
    pending: 0,
    failed: 0,
    deadLetter: 0,
    staleLocks: 0,
    oldestPendingAgeMs: 0,
    quarantine: { messageQuarantine: 0, recoveryQuarantine: 0 },
    pendingWarn: 50,
    pendingBlocked: 200,
    failedWarn: 10,
  };
  for (const [changes, expected] of [
    [{ pending: 49 }, "ok"],
    [{ pending: 50 }, "degraded"],
    [{ pending: 199 }, "degraded"],
    [{ pending: 200 }, "blocked"],
    [{ failed: 9 }, "ok"],
    [{ failed: 10 }, "degraded"],
    [{ oldestPendingAgeMs: 31999 }, "ok"],
    [{ oldestPendingAgeMs: 32000 }, "degraded"],
    [{ pending: 5, pendingWarn: 5 }, "degraded"],
    [{ pending: 20, pendingBlocked: 20 }, "blocked"],
    [{ failed: 2, failedWarn: 2 }, "degraded"],
    [{ deadLetter: 1, staleLocks: 1 }, "blocked"],
    [{ quarantine: { messageQuarantine: 1, recoveryQuarantine: 0 } }, "blocked"],
    [{ quarantine: { messageQuarantine: 0, recoveryQuarantine: 1 } }, "blocked"],
    [{ quarantine: { messageQuarantine: 1, recoveryQuarantine: 1 } }, "blocked"],
  ]) {
    const input = { ...base, ...changes };
    const alerts = buildOutboxAlerts(input);
    assert.equal(outboxReadinessStatus(input), expected, JSON.stringify(changes));
    assert.equal(
      alerts.some((item) => item.severity === "critical"),
      expected === "blocked",
    );
    assert.equal(alerts.length === 0, expected === "ok");
  }
});

test("async consumer parses Kafka messages and derives idempotency keys", () => {
  const message = {
    topic: "tests",
    partition: 0,
    offset: "41",
    value: JSON.stringify({
      eventId: "evt_1",
      eventType: "test.async",
      traceId: "trace-1",
      payload: { ok: true },
      occurredAt: "2026-01-01T00:00:00.000Z",
    }),
  };
  const task = parseAsyncTaskMessage(message, "group-a", {
    now: new Date("2026-01-01T00:00:01.000Z"),
  });
  assert.equal(task.taskId, "evt_1");
  assert.equal(task.taskType, "test.async");
  assert.equal(task.idempotencyKey, "test.async:evt_1");
  assert.deepEqual(task.source.offset, {
    topic: "tests",
    partition: 0,
    offset: "41",
    consumerGroup: "group-a",
  });
  assert.equal(nextKafkaOffset("41"), "42");
  assert.equal(
    asyncTaskIdempotencyKey({
      eventType: "test.async",
      eventId: "evt_1",
      idempotencyKey: "manual",
    }),
    "manual",
  );
});

test("offset failure never rewrites a successful domain transaction", async () => {
  let failed = 0,
    executed = 0;
  const message = {
    topic: "tests",
    partition: 0,
    offset: "0",
    value: JSON.stringify({
      eventId: "evt",
      eventType: "demo.echo",
      traceId: "trace",
      payload: {},
    }),
  };
  const options = {
    consumerGroup: "group",
    workerId: "worker",
    store: {
      async claim(task) {
        return {
          kind: "claimed",
          task: { ...task, generation: 1, requestHash: "hash" },
        };
      },
      async execute() {
        executed++;
      },
      async fail() {
        failed++;
      },
      async quarantine() {
        throw new Error("unexpected poison");
      },
    },
    handler: async () => {},
    commitOffset: async () => {
      throw new Error("offset unavailable");
    },
  };
  await assert.rejects(() => processAsyncConsumerMessage(message, options), /offset unavailable/);
  assert.equal(executed, 1);
  assert.equal(failed, 0);
});

test("missing offset callback does not report a Kafka commit", async () => {
  const message = {
    topic: "tests",
    partition: 0,
    offset: "0",
    value: JSON.stringify({
      eventId: "evt",
      eventType: "demo.echo",
      traceId: "trace",
      payload: {},
    }),
  };
  const result = await processAsyncConsumerMessage(message, {
    consumerGroup: "group",
    workerId: "worker",
    handler: async () => {},
    store: {
      async claim(task) {
        return { kind: "terminal", task };
      },
      async execute() {},
      async fail() {},
      async quarantine() {},
    },
  });
  assert.equal(result.safeToCommit, true);
  assert.equal(result.committed, false);
});

test("processConsumerMessagesSequentially stops at retryable messages", async () => {
  const messages = [
    { topic: "tests", partition: 0, offset: "0", value: "{}" },
    { topic: "tests", partition: 0, offset: "1", value: "{}" },
  ];
  const committed = [];
  const result = await processConsumerMessagesSequentially(
    messages,
    async (message) => ({
      eventId: message.offset,
      taskId: message.offset,
      traceId: "trace",
      idempotencyKey: message.offset,
      status: message.offset === "0" ? "succeeded" : "failed",
      committed: false,
      safeToCommit: message.offset === "0",
    }),
    async (message) => {
      committed.push(message.offset);
    },
  );
  assert.deepEqual(result, { processed: 2, stoppedOnRetryableFailure: true });
  assert.deepEqual(committed, ["0"]);
});

test("failAsyncTask calculates retry and dead-letter states", () => {
  const baseTask = {
    taskId: "task-1",
    taskType: "test.async",
    traceId: "trace",
    status: "running",
    payload: {},
    idempotencyKey: "idem",
    attemptCount: 1,
    maxAttempts: 2,
    sourceEventId: "evt",
    source: { eventId: "evt", eventType: "test.async" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const failed = failAsyncTask(baseTask, new Error("boom"), {
    now: new Date("2026-01-01T00:00:00.000Z"),
    retryBaseMs: 1000,
    retryMaxMs: 1000,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.attemptCount, 2);
  assert.equal(failed.nextRetryAt, "2026-01-01T00:00:01.000Z");

  const deadLetter = failAsyncTask({ ...baseTask, attemptCount: 2 }, "again", {
    now: new Date("2026-01-01T00:00:02.000Z"),
  });
  assert.equal(deadLetter.status, "dead_letter");
  assert.equal(deadLetter.attemptCount, 2);
  assert.equal(deadLetter.errorCode, "ASYNC_TASK_DEAD_LETTER");
});

test("heartbeat serializes overlapping writes and shutdown is terminal", async () => {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHeartbeatWriter, inspectWorkerHeartbeat } = await import("../src/heartbeat.ts");
  const directory = await mkdtemp(join(tmpdir(), "worker-heartbeat-"));
  try {
    const destination = join(directory, "heartbeat.json");
    const writer = createHeartbeatWriter(destination);
    const writes = Array.from({ length: 100 }, (_, index) =>
      writer.write("running", Date.now() + index),
    );
    const stopped = writer.write("stopped", 123);
    const late = writer.write("running", 456);
    await Promise.all([...writes, stopped, late]);
    const record = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(record.state, "stopped");
    assert.equal(record.lastProgressAt, 123);
    assert.equal((await inspectWorkerHeartbeat(destination)).status, "degraded");
    assert.deepEqual(await readdir(directory), ["heartbeat.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("heartbeat default destinations identify separate runtime instances", async () => {
  const { createHeartbeatWriter } = await import("../src/heartbeat.ts");
  const previous = process.env.WORKER_HEARTBEAT_PATH;
  delete process.env.WORKER_HEARTBEAT_PATH;
  try {
    assert.notEqual(createHeartbeatWriter().destination, createHeartbeatWriter().destination);
  } finally {
    if (previous !== undefined) process.env.WORKER_HEARTBEAT_PATH = previous;
  }
});

test("JSON storage rejects lone surrogates in nested strings and keys but accepts paired emoji", () => {
  const input = (payload) => ({
    topic: "unicode",
    partition: 0,
    offset: "0",
    value: JSON.stringify({
      eventId: "unicode",
      eventType: "demo.echo",
      traceId: "unicode",
      payload,
    }),
  });
  for (const payload of [
    "\ud800",
    "\udc00",
    { nested: ["\ud800x"] },
    { ["\udc00"]: true },
    "\u0000",
  ])
    assert.throws(
      () => parseAsyncTaskMessage(input(payload), "unicode"),
      /unsupported by PostgreSQL JSON/,
    );
  assert.deepEqual(parseAsyncTaskMessage(input({ "😀": ["a😀z"] }), "unicode").payload, {
    "😀": ["a😀z"],
  });
});

test("async identifiers and the serialized consumer key fit PostgreSQL index budgets", () => {
  const input = (extra = {}) => ({
    topic: "tests",
    partition: 0,
    offset: "0",
    value: JSON.stringify({
      eventId: "evt",
      eventType: "demo.echo",
      traceId: "trace",
      payload: {},
      ...extra,
    }),
  });
  const group = "group";
  const overhead = Buffer.byteLength(JSON.stringify([group, ""]));
  const key = "x".repeat(2000 - overhead);
  assert.equal(parseAsyncTaskMessage(input({ idempotencyKey: key }), group).idempotencyKey, key);
  for (const extra of [
    { idempotencyKey: key + "x" },
    { eventType: "x".repeat(1000), eventId: "y".repeat(1000) },
    { idempotencyKey: "😀".repeat(500) },
    { idempotencyKey: '"'.repeat(1000) },
    { idempotencyKey: "a\u0001".repeat(400) },
    ...["eventId", "eventType", "traceId", "taskId"].map((field) => ({
      [field]: "😀".repeat(501),
    })),
  ])
    assert.throws(() => parseAsyncTaskMessage(input(extra), group), /2000|UTF-8/);
  assert.equal(
    parseAsyncTaskMessage(input({ idempotencyKey: "legacy" }), " group ").source.offset
      .consumerGroup,
    " group ",
  );
});

test("invalid Kafka metadata fails before quarantine or acknowledgement", async () => {
  const input = { topic: "tests", partition: 0, offset: "0", value: "broken" };
  let writes = 0;
  const options = {
    consumerGroup: "group",
    workerId: "worker",
    store: {
      async quarantine() {
        writes++;
      },
    },
    handler: async () => {},
    commitOffset: async () => {
      writes++;
    },
  };
  for (const extra of [
    { topic: "x".repeat(250) },
    { topic: "bad\u0000topic" },
    { offset: "1".repeat(20) },
    { offset: "invalid" },
    { partition: -1 },
  ])
    await assert.rejects(processAsyncConsumerMessage({ ...input, ...extra }, options));
  for (const consumerGroup of [
    "x".repeat(257),
    "😀".repeat(65),
    "bad\u0000group",
    "bad\ud800group",
  ])
    await assert.rejects(processAsyncConsumerMessage(input, { ...options, consumerGroup }));
  assert.equal(writes, 0);
});

test("worker configuration rejects oversized groups and preserves existing group identity", async () => {
  const { loadWorkerEnv } = await import("../src/env.ts");
  const previous = process.env.KAFKA_CONSUMER_GROUP_ID;
  const skip = process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES;
  process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES = "1";
  try {
    process.env.KAFKA_CONSUMER_GROUP_ID = " existing-group ";
    assert.equal(loadWorkerEnv().kafkaConsumerGroupId, " existing-group ");
    process.env.KAFKA_CONSUMER_GROUP_ID = "😀".repeat(65);
    assert.throws(() => loadWorkerEnv(), /256 UTF-8 bytes/);
  } finally {
    if (previous === undefined) delete process.env.KAFKA_CONSUMER_GROUP_ID;
    else process.env.KAFKA_CONSUMER_GROUP_ID = previous;
    if (skip === undefined) delete process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES;
    else process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES = skip;
  }
});

test("worker shutdown timeout validates the documented integer range", async () => {
  const { loadWorkerEnv } = await import("../src/env.ts");
  const previous = process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
  try {
    delete process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    assert.equal(loadWorkerEnv().workerShutdownTimeoutMs, 30000);
    for (const value of ["1", "300000"]) {
      process.env.WORKER_SHUTDOWN_TIMEOUT_MS = value;
      assert.equal(loadWorkerEnv().workerShutdownTimeoutMs, Number(value));
    }
    for (const value of ["0", "-1", "1.5", "300001", "Infinity", "invalid"]) {
      process.env.WORKER_SHUTDOWN_TIMEOUT_MS = value;
      assert.throws(() => loadWorkerEnv(), /WORKER_SHUTDOWN_TIMEOUT_MS/);
    }
  } finally {
    if (previous === undefined) delete process.env.WORKER_SHUTDOWN_TIMEOUT_MS;
    else process.env.WORKER_SHUTDOWN_TIMEOUT_MS = previous;
  }
});

test("heartbeat stopping rejects late progress and failed is terminal", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHeartbeatWriter, inspectWorkerHeartbeat } = await import("../src/heartbeat.ts");
  const directory = await mkdtemp(join(tmpdir(), "worker-heartbeat-states-"));
  try {
    const file = join(directory, "heartbeat.json"),
      writer = createHeartbeatWriter(file);
    for (const state of ["starting", "running", "stopping"]) {
      await writer.write(state, Date.now());
      assert.equal(
        (await inspectWorkerHeartbeat(file)).status,
        state === "running" ? "ok" : "degraded",
      );
    }
    await writer.write("running", 1);
    assert.equal(JSON.parse(await readFile(file, "utf8")).state, "stopping");
    await Promise.all([
      writer.write("failed", 2),
      writer.write("running", 3),
      writer.write("stopped", 4),
    ]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).state, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
