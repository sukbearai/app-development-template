import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { Kafka, logLevel } from "kafkajs";
import {
  claimEvents,
  markPublished,
  processOutboxOnce,
} from "../src/outbox.ts";
import {
  createPostgresAsyncTaskStore,
  parseAsyncTaskMessage,
  processAsyncConsumerMessage,
  runKafkaConsumer,
  StaleLeaseError,
} from "../src/async-consumer.ts";
import { handleDomainEvent } from "../src/domain-handler.ts";

process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES = "1";
if (!process.env.WORKER_TEST_DATABASE_URL)
  throw new Error(
    "WORKER_TEST_DATABASE_URL must identify an isolated empty test database",
  );
const pool = new Pool({
  connectionString: process.env.WORKER_TEST_DATABASE_URL,
});
const group = `proof-${randomUUID()}`;
const store = createPostgresAsyncTaskStore({ pool });
const options = {
  store,
  consumerGroup: group,
  workerId: "worker-a",
  handler: handleDomainEvent,
  retryBaseMs: 20,
  retryMaxMs: 20,
};
const message = (id = randomUUID(), payload = { value: 1 }, extra = {}) => ({
  topic: "app.tasks",
  partition: 0,
  offset: "0",
  value: JSON.stringify({
    eventId: id,
    eventType: "demo.echo",
    traceId: "proof",
    payload,
    ...extra,
  }),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const count = await pool.query(
    "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(
    count.rows[0].n,
    0,
    "integration test requires an empty database",
  );
  const directory =
    process.env.WORKER_TEST_MIGRATIONS ??
    new URL("../../../packages/database/migrations/template/", import.meta.url)
      .pathname;
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort())
    await pool.query(await readFile(path.join(directory, file), "utf8"));
});
after(async () => {
  await pool.end();
});

test("dry-run observes without changing any persisted outbox bytes", async () => {
  await pool.query(
    "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload)VALUES('dry','app.tasks','demo.echo','proof','{}')",
  );
  const before = await pool.query(
    "SELECT row_to_json(e) snapshot FROM app_outbox_events e",
  );
  const result = await processOutboxOnce({ pool, dryRun: true });
  assert.equal(result.inspected, 1);
  assert.equal(result.claimed, 0);
  assert.equal(result.published, 0);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT row_to_json(e) snapshot FROM app_outbox_events e",
      )
    ).rows,
    before.rows,
  );
});

test("expired publisher lease recovers and rejects the old publisher acknowledgement", async () => {
  const client = await pool.connect();
  try {
    const [first] = await claimEvents(client, {
      batchSize: 1,
      workerId: "old",
      leaseMs: 10,
    });
    await sleep(25);
    const [second] = await claimEvents(client, {
      batchSize: 1,
      workerId: "new",
      leaseMs: 10000,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.leaseGeneration, first.leaseGeneration + 1);
    assert.equal(await markPublished(pool, first, "old"), false);
    assert.equal(await markPublished(pool, second, "new"), true);
  } finally {
    client.release();
  }
});

test("concurrent identical delivery executes one transactional domain effect and one receipt", async () => {
  const input = message();
  let executions = 0;
  const execute = async (task, { client }) => {
    executions++;
    await client.query("SELECT pg_sleep(0.08)");
    return { value: task.payload };
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      processAsyncConsumerMessage(input, { ...options, handler: execute }),
    ),
  );
  assert.equal(executions, 1);
  assert.equal(results.filter((r) => r.status === "succeeded").length, 1);
  const key = JSON.stringify([
    group,
    parseAsyncTaskMessage(input, group).idempotencyKey,
  ]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_async_receipts WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM app_idempotency_keys WHERE key=$1", [
        key,
      ])
    ).rows[0].status,
    "succeeded",
  );
});

test("payload key order is canonical but changed values are quarantined without modifying success", async () => {
  const id = randomUUID();
  await processAsyncConsumerMessage(message(id, { a: 1, b: 2 }), options);
  assert.equal(
    (await processAsyncConsumerMessage(message(id, { b: 2, a: 1 }), options))
      .status,
    "skipped_duplicate",
  );
  const conflict = await processAsyncConsumerMessage(
    { ...message(id, { a: 2, b: 2 }), offset: "9" },
    options,
  );
  assert.equal(conflict.status, "quarantined");
  assert.equal(conflict.errorCode, "IDEMPOTENCY_CONFLICT");
});

test("receipt insert failure rolls back domain write and success event before durable failure", async () => {
  const id = randomUUID();
  const input = message(id);
  const task = parseAsyncTaskMessage(input, group);
  const key = JSON.stringify([group, task.idempotencyKey]);
  await pool.query(
    "INSERT INTO app_async_receipts(idempotency_key,task_id,consumer_group,event_type,payload_hash,result)VALUES($1,$2,$3,'demo.echo','collision','{}')",
    [key, id, group],
  );
  const result = await processAsyncConsumerMessage(input, {
    ...options,
    handler: async (_task, { client }) => {
      await client.query(
        "INSERT INTO app_telemetry_events(id,event,trace_id,payload)VALUES($1,'transaction-probe','proof','{}')",
        [id],
      );
    },
  });
  assert.equal(result.status, "failed");
  assert.match(
    result.errorMessage,
    /duplicate key value violates unique constraint/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_telemetry_events WHERE id=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query("SELECT status FROM app_idempotency_keys WHERE key=$1", [
        key,
      ])
    ).rows[0].status,
    "failed",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_task_events WHERE payload->>'sourceEventId'=$1 AND status='succeeded'",
        [id],
      )
    ).rows[0].n,
    0,
  );
});

test("offset failure preserves success, domain projection, and completed receipt", async () => {
  const input = message();
  let executes = 0;
  await assert.rejects(
    () =>
      processAsyncConsumerMessage(input, {
        ...options,
        handler: async () => {
          executes++;
          return { ok: true };
        },
        commitOffset: async () => {
          throw new Error("offset unavailable");
        },
      }),
    /offset unavailable/,
  );
  assert.equal(
    (await processAsyncConsumerMessage(input, options)).status,
    "skipped_duplicate",
  );
  assert.equal(executes, 1);
});

test("retry survives store recreation, defers until due, and dead letter replay is durable", async () => {
  const input = message(randomUUID(), {}, { maxAttempts: 2 });
  const broken = {
    ...options,
    handler: async () => {
      throw new Error("domain rejected");
    },
    retryBaseMs: 100,
    retryMaxMs: 100,
  };
  assert.equal(
    (await processAsyncConsumerMessage(input, broken)).status,
    "failed",
  );
  const fresh = createPostgresAsyncTaskStore({ pool });
  assert.equal(
    (await processAsyncConsumerMessage(input, { ...broken, store: fresh }))
      .status,
    "deferred_retry",
  );
  await sleep(120);
  const dead = await processAsyncConsumerMessage(input, {
    ...broken,
    store: fresh,
  });
  assert.equal(dead.status, "dead_letter");
  assert.equal(dead.safeToCommit, true);
  assert.equal(
    await fresh.replay(
      group,
      parseAsyncTaskMessage(input, group).idempotencyKey,
    ),
    true,
  );
  const due = await fresh.dueMessages(group);
  assert.ok(
    due.some(
      (item) =>
        JSON.parse(item.value).eventId === JSON.parse(input.value).eventId,
    ),
  );
  assert.equal(
    (await processAsyncConsumerMessage(input, { ...options, store: fresh }))
      .status,
    "succeeded",
  );
});

test("stale task owner cannot execute or fail after another owner recovers", async () => {
  const short = createPostgresAsyncTaskStore({ pool, leaseMs: 10 });
  const task = parseAsyncTaskMessage(message(), group);
  const first = await short.claim(task, "old");
  assert.equal(first.kind, "claimed");
  await sleep(25);
  const second = await store.claim(task, "new");
  assert.equal(second.kind, "claimed");
  assert.equal(second.task.generation, first.task.generation + 1);
  await assert.rejects(
    () => short.execute(first.task, handleDomainEvent),
    StaleLeaseError,
  );
  await assert.rejects(
    () => short.fail({ ...first.task, status: "failed" }),
    StaleLeaseError,
  );
  await store.execute(second.task, handleDomainEvent);
});

test("malformed and null messages persist quarantine before acknowledgement", async () => {
  for (const [index, value] of [
    "{broken",
    null,
    "\u0000",
    message("high-surrogate", { nested: ["\ud800"] }).value,
    message("low-surrogate", { ["\udc00"]: true }).value,
    JSON.stringify({
      eventId: "nul",
      eventType: "demo.echo",
      traceId: "proof",
      payload: "\u0000",
    }),
  ].entries()) {
    let committed = false;
    const result = await processAsyncConsumerMessage(
      { topic: "poison", partition: 0, offset: String(index), value },
      {
        ...options,
        commitOffset: async () => {
          const durable = await pool.query(
            "SELECT error_code FROM app_message_quarantine WHERE consumer_group=$1 AND topic='poison' AND source_offset=$2",
            [group, String(index)],
          );
          assert.equal(durable.rows[0]?.error_code, "INVALID_MESSAGE");
          committed = true;
        },
      },
    );
    assert.equal(result.status, "quarantined");
    assert.equal(committed, true);
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM app_message_quarantine WHERE topic='poison'",
      )
    ).rows[0].n,
    6,
  );
});

test("real Kafka outbox delivery retries exact offset then advances and quarantines poison", async () => {
  if (!process.env.WORKER_TEST_KAFKA_BROKERS)
    throw new Error(
      "WORKER_TEST_KAFKA_BROKERS is required for complete middleware verification",
    );
  const brokers = process.env.WORKER_TEST_KAFKA_BROKERS.split(",");
  const kafka = new Kafka({
    clientId: "worker-proof",
    brokers,
    logLevel: logLevel.NOTHING,
  });
  const topic = `proof-${randomUUID()}`,
    kafkaGroup = `proof-${randomUUID()}`;
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });
  const producer = kafka.producer();
  await producer.connect();
  const id = randomUUID();
  try {
    await pool.query(
      "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload)VALUES($1,$2,'demo.echo','proof','{}')",
      [id, topic],
    );
    assert.equal(
      (await processOutboxOnce({ pool, producer, dryRun: false })).published,
      1,
    );
    const overdueId = randomUUID();
    await producer.send({
      topic,
      messages: [
        { value: "broken" },
        { value: message(overdueId).value },
        { value: message("unicode-high", { nested: ["\ud800"] }).value },
        { value: message("unicode-low", { ["\udc00"]: true }).value },
        { value: message("unicode-nul", "\u0000").value },
        { value: message("unicode-valid", { "😀": ["a😀z"] }).value },
      ],
    });
    let overdueCalls = 0;
    let calls = 0;
    const offsets = [];
    const runner = await runKafkaConsumer({
      topic,
      brokers,
      groupId: kafkaGroup,
      maxMessages: 7,
      maxWaitMs: 30000,
      eachMessage: async (input) => {
        offsets.push(input.offset);
        return processAsyncConsumerMessage(input, {
          ...options,
          consumerGroup: kafkaGroup,
          now: input.offset === "2" ? new Date(Date.now() - 1000) : undefined,
          handler: async (task) => {
            if (task.sourceEventId === id && ++calls === 1)
              throw new Error("retry once");
            if (task.sourceEventId === overdueId && ++overdueCalls === 1)
              throw new Error("overdue retry once");
            return { ok: true };
          },
        });
      },
    });
    assert.equal(runner.processed, 7);
    assert.equal(calls, 2);
    assert.equal(overdueCalls, 2);
    assert.deepEqual(offsets, ["0", "0", "1", "2", "2", "3", "4", "5", "6"]);
    const quarantined = await pool.query(
      "SELECT source_offset FROM app_message_quarantine WHERE consumer_group=$1 ORDER BY source_offset",
      [kafkaGroup],
    );
    assert.deepEqual(
      quarantined.rows.map((row) => row.source_offset),
      ["1", "3", "4", "5"],
    );
    const emoji = await pool.query(
      "SELECT response_data->'payload' AS payload FROM app_idempotency_keys WHERE key=$1",
      [JSON.stringify([kafkaGroup, "demo.echo:unicode-valid"])],
    );
    assert.deepEqual(emoji.rows[0].payload, { "😀": ["a😀z"] });
    const fetched = await admin.fetchOffsets({
      groupId: kafkaGroup,
      topics: [topic],
    });
    assert.equal(fetched[0].partitions[0].offset, "7");
  } finally {
    await producer.disconnect();
    await admin.disconnect();
  }
});

test("SIGKILL after broker acceptance recovers publisher lease and duplicate yields one receipt", async () => {
  const { fork } = await import("node:child_process");
  const brokers = process.env.WORKER_TEST_KAFKA_BROKERS.split(",");
  const kafka = new Kafka({
    clientId: "crash-proof",
    brokers,
    logLevel: logLevel.NOTHING,
  });
  const topic = `crash-${randomUUID()}`,
    groupId = `crash-${randomUUID()}`,
    id = randomUUID();
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });
  await pool.query(
    "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload)VALUES($1,$2,'demo.echo','proof','{}')",
    [id, topic],
  );
  const child = fork(
    new URL("./fixtures/crash-publisher.mjs", import.meta.url),
    [],
    {
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: process.env,
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const producer = kafka.producer();
  await producer.connect();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`child publisher timeout: ${stderr}`)),
        15000,
      );
      child.once("message", (event) => {
        clearTimeout(timer);
        assert.equal(event.sent, id);
        resolve();
      });
      child.once("error", reject);
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    await sleep(350);
    assert.equal(
      (await processOutboxOnce({ pool, producer, dryRun: false })).published,
      1,
    );
    let executions = 0;
    await runKafkaConsumer({
      topic,
      brokers,
      groupId,
      maxMessages: 2,
      maxWaitMs: 20000,
      eachMessage: (input) =>
        processAsyncConsumerMessage(input, {
          ...options,
          consumerGroup: groupId,
          handler: async () => {
            executions++;
            return { ok: true };
          },
        }),
    });
    assert.equal(executions, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT lease_generation,status FROM app_outbox_events WHERE id=$1",
          [id],
        )
      ).rows[0].lease_generation,
      2,
    );
  } finally {
    child.kill("SIGKILL");
    await producer.disconnect();
    await admin.disconnect();
  }
});

test("runtime SIGTERM stops claims, closes Kafka and pool, and marks heartbeat stopped", async () => {
  const { spawn } = await import("node:child_process");
  const { rm } = await import("node:fs/promises");
  const heartbeat = new URL(
    `./.heartbeat-${randomUUID()}.json`,
    import.meta.url,
  ).pathname;
  const runtimeTopic = `shutdown-${randomUUID()}`;
  const runtimeGroup = `shutdown-${randomUUID()}`;
  const eventId = randomUUID();
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      new URL("../src/index.ts", import.meta.url).pathname,
      "async-runtime",
      "--interval-ms",
      "100",
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: process.env.WORKER_TEST_DATABASE_URL,
        KAFKA_BROKERS: process.env.WORKER_TEST_KAFKA_BROKERS,
        OUTBOX_PUBLISHER: "kafka",
        ASYNC_RUNTIME_TOPICS: runtimeTopic,
        KAFKA_CONSUMER_GROUP_ID: runtimeGroup,
        ASYNC_TASK_DEFAULT_MAX_ATTEMPTS: "1",
        ASYNC_TASK_IDEMPOTENCY_TTL_HOURS: "3",
        WORKER_HEARTBEAT_PATH: heartbeat,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('"iteration":1') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(stderr);
      await sleep(50);
    }
    assert.ok(
      output.includes('"iteration":1'),
      `runtime did not start: ${stderr}`,
    );
    const producer = new Kafka({
      brokers: process.env.WORKER_TEST_KAFKA_BROKERS.split(","),
      logLevel: logLevel.NOTHING,
    }).producer();
    await producer.connect();
    try {
      await producer.send({
        topic: runtimeTopic,
        messages: [
          {
            value: message(eventId, {}, { eventType: "unsupported.test" })
              .value,
          },
        ],
      });
    } finally {
      await producer.disconnect();
    }
    let stored;
    const taskDeadline = Date.now() + 15000;
    while (Date.now() < taskDeadline) {
      const result = await pool.query(
        "SELECT status,response_data,extract(epoch from expires_at-created_at)/3600 AS ttl FROM app_idempotency_keys WHERE key=$1",
        [JSON.stringify([runtimeGroup, `unsupported.test:${eventId}`])],
      );
      stored = result.rows[0];
      if (stored?.status === "dead_letter") break;
      await sleep(50);
    }
    assert.equal(stored?.status, "dead_letter");
    assert.equal(stored.response_data.maxAttempts, 1);
    assert.equal(stored.response_data.attemptCount, 1);
    assert.equal(Number(stored.ttl), 3);
    // Cross at least two periodic heartbeat ticks while the outbox loop also writes.
    await sleep(6500);
    const { inspectWorkerHeartbeat } = await import("../src/heartbeat.ts");
    assert.equal((await inspectWorkerHeartbeat(heartbeat)).status, "ok");
    assert.equal(child.exitCode, null, stderr);
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SIGTERM drain timeout")),
        15000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.kill("SIGTERM");
    assert.equal(await exit, 0, stderr);
    assert.equal(
      JSON.parse(await readFile(heartbeat, "utf8")).state,
      "stopped",
    );
  } finally {
    child.kill("SIGKILL");
    await rm(heartbeat, { force: true });
  }
});

test("retention compacts worker history while preserving duplicate and conflict protection", async () => {
  const { runRetention } = await import("@pstack/database/repository");
  const { closeDatabase } = await import("@pstack/database/client");
  const previousDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
  try {
    const input = message();
    let executions = 0;
    const handler = async () => {
      executions++;
      return { effect: "once" };
    };
    await processAsyncConsumerMessage(input, { ...options, handler });
    const task = parseAsyncTaskMessage(input, group);
    const key = JSON.stringify([group, task.idempotencyKey]);
    const receiptBefore = (
      await pool.query(
        "SELECT * FROM app_async_receipts WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0];
    const taskBefore = (
      await pool.query(
        "SELECT id FROM app_tasks WHERE object_type='async_task' AND object_id=$1",
        [task.taskId],
      )
    ).rows[0];
    assert.equal(receiptBefore.task_id, task.taskId);
    assert.notEqual(receiptBefore.task_id, taskBefore.id);
    await pool.query(
      "UPDATE app_idempotency_keys SET created_at='2000-01-01',expires_at='2000-01-02' WHERE key=$1",
      [key],
    );
    await pool.query(
      "UPDATE app_async_receipts SET created_at='2000-01-01' WHERE idempotency_key=$1",
      [key],
    );
    await pool.query(
      "UPDATE app_task_events SET created_at='2000-01-01' WHERE task_id=$1",
      [taskBefore.id],
    );
    const retention = {
      before: new Date("2001-01-01"),
      batchSize: 100,
      dryRun: true,
    };
    const preview = await runRetention(retention);
    assert.equal(preview.receipts, 1);
    assert.equal(preview.idempotency, 1);
    assert.equal(preview.taskEvents, 2);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT result FROM app_async_receipts WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0].result,
      { effect: "once" },
    );
    assert.deepEqual(
      await runRetention({ ...retention, dryRun: false }),
      preview,
    );
    assert.deepEqual(await runRetention({ ...retention, dryRun: false }), {
      taskEvents: 0,
      outbox: 0,
      telemetry: 0,
      audit: 0,
      idempotency: 0,
      receipts: 0,
    });
    const receiptAfter = (
      await pool.query(
        "SELECT * FROM app_async_receipts WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0];
    for (const field of [
      "idempotency_key",
      "task_id",
      "consumer_group",
      "event_type",
      "payload_hash",
    ])
      assert.equal(receiptAfter[field], receiptBefore[field]);
    assert.deepEqual(receiptAfter.result, {});
    const tombstone = (
      await pool.query(
        "SELECT response_data,status FROM app_idempotency_keys WHERE key=$1",
        [key],
      )
    ).rows[0];
    assert.equal(tombstone.response_data, null);
    assert.equal(tombstone.status, "succeeded");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM app_task_events WHERE task_id=$1",
          [taskBefore.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query("SELECT status FROM app_tasks WHERE id=$1", [
          taskBefore.id,
        ])
      ).rows[0].status,
      "succeeded",
    );
    const recreated = createPostgresAsyncTaskStore({ pool });
    assert.equal(
      (
        await processAsyncConsumerMessage(input, {
          ...options,
          store: recreated,
          handler,
        })
      ).status,
      "skipped_duplicate",
    );
    const conflict = message(JSON.parse(input.value).eventId, {
      changed: true,
    });
    conflict.offset = "999";
    assert.equal(
      (
        await processAsyncConsumerMessage(conflict, {
          ...options,
          store: recreated,
          handler,
        })
      ).errorCode,
      "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(executions, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM app_async_receipts WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await closeDatabase();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
  }
});
