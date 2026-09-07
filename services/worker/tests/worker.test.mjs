import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asyncTaskIdempotencyKey,
  failAsyncTask,
  nextKafkaOffset,
  parseAsyncTaskMessage,
  processAsyncConsumerMessage,
  processConsumerMessagesSequentially,
} from "../src/async-consumer.ts";
import {
  asyncRuntimeTopics,
  buildAsyncRuntimePlan,
} from "../src/async-runtime.ts";
import {
  outboxKafkaMessageValue,
  publishEvent,
  publishOutboxOnce,
  workerHealth,
} from "../src/index.ts";
import { redact } from "../src/logger.ts";
import {
  buildOutboxAlerts,
  outboxReadinessStatus,
} from "../src/outbox-readiness.ts";
import { outboxKafkaMessageKey } from "../src/outbox.ts";

process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES = "1";

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

test("publishEvent supports dry-run and requires kafka brokers", async () => {
  const previous = process.env.OUTBOX_PUBLISHER;
  const previousBrokers = process.env.KAFKA_BROKERS;
  process.env.OUTBOX_PUBLISHER = "dry-run";
  const ok = await publishEvent({
    id: "evt_test",
    topic: "tests",
    event_type: "test.created",
    trace_id: "trace-test",
    payload: {},
    attempts: 0,
  });
  assert.equal(ok.status, "ok");
  process.env.OUTBOX_PUBLISHER = "kafka";
  delete process.env.KAFKA_BROKERS;
  await assert.rejects(
    () =>
      publishEvent({
        id: "evt_test",
        topic: "tests",
        event_type: "test.created",
        trace_id: "trace-test",
        payload: {},
        attempts: 0,
      }),
    /KAFKA_BROKERS is required/,
  );
  if (previous === undefined) {
    delete process.env.OUTBOX_PUBLISHER;
  } else {
    process.env.OUTBOX_PUBLISHER = previous;
  }
  if (previousBrokers === undefined) {
    delete process.env.KAFKA_BROKERS;
  } else {
    process.env.KAFKA_BROKERS = previousBrokers;
  }
});

test("worker logger redacts sensitive fields recursively", () => {
  assert.deepEqual(
    redact({ token: "secret", nested: { accessKey: "key", ok: true } }),
    {
      token: "[REDACTED]",
      nested: { accessKey: "[REDACTED]", ok: true },
    },
  );
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
  await assert.rejects(
    () => processAsyncConsumerMessage(message, options),
    /offset unavailable/,
  );
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
  const { createHeartbeatWriter, inspectWorkerHeartbeat } = await import(
    "../src/heartbeat.ts"
  );
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
    assert.equal(
      (await inspectWorkerHeartbeat(destination)).status,
      "degraded",
    );
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
    assert.notEqual(
      createHeartbeatWriter().destination,
      createHeartbeatWriter().destination,
    );
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
  assert.deepEqual(
    parseAsyncTaskMessage(input({ "😀": ["a😀z"] }), "unicode").payload,
    { "😀": ["a😀z"] },
  );
});
