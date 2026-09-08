import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  payloadHash,
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

test("outbox publishing refuses incomplete restores while dry-run stays read-only", async () => {
  const id = `restore-guard-${randomUUID()}`;
  await pool.query("INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload,created_at) VALUES($1,'app.tasks','demo.echo','restore-guard','{}','1970-01-01')", [id]);
  let sends = 0;
  const producer = { async send() { sends++; } };
  const snapshot = async () => (await pool.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [id])).rows;
  try {
    for (const state of ["guard", "restoring"]) {
      if (state === "guard") await pool.query("CREATE SCHEMA pstack_restore_guard");
      else await pool.query("INSERT INTO app_kafka_recovery(state,logical_group,transport_group,checkpoint) VALUES('restoring',$1,'data-only-recovery-disabled','{}')", [group]);
      const before = await snapshot();
      const dryRun = await processOutboxOnce({ pool, producer, dryRun: true, batchSize: 1 });
      assert.equal(dryRun.claimed, 0);
      await assert.rejects(processOutboxOnce({ pool, producer, dryRun: false, batchSize: 1 }), /restore|recovery/i);
      assert.equal(sends, 0);
      assert.deepEqual(await snapshot(), before);
      if (state === "guard") await pool.query("DROP SCHEMA pstack_restore_guard");
    }
    await pool.query("UPDATE app_kafka_recovery SET state='ready'");
    const invalidReadyBefore = await snapshot();
    await assert.rejects(processOutboxOnce({ pool, producer, dryRun: false, batchSize: 1 }));
    assert.equal(sends, 0);
    assert.deepEqual(await snapshot(), invalidReadyBefore);
    await pool.query("DELETE FROM app_kafka_recovery");
    const published = await processOutboxOnce({ pool, producer, dryRun: false, batchSize: 1 });
    assert.equal(published.published, 1);
    assert.equal(sends, 1);
    assert.equal((await snapshot())[0].snapshot.status, "published");
    await pool.query("UPDATE app_outbox_events SET status='pending' WHERE id=$1", [id]);
    await assert.rejects(processOutboxOnce({ pool, dryRun: false, batchSize: 2, producer: {
      async send() { await pool.query("INSERT INTO app_kafka_recovery(state,logical_group,transport_group,checkpoint) VALUES('restoring',$1,'data-only-recovery-disabled','{}')", [group]); },
    } }), /recovery is incomplete/);
    assert.equal((await snapshot())[0].snapshot.status, "published");
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS pstack_restore_guard");
    await pool.query("DELETE FROM app_kafka_recovery");
    await pool.query("DELETE FROM app_outbox_events WHERE id=$1", [id]);
  }
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

test("Unicode payload survives JSONB durable retry and later duplicate delivery", async () => {
  const id = randomUUID();
  const consumerGroup = `unicode-${id}`;
  const input = message(id, { "e\u0301": 2, "\u00e9": 1 });
  let executions = 0;
  const handler = async () => {
    executions++;
    if (executions === 1) throw new Error("temporary handler failure");
    return { recovered: true };
  };
  const settings = { ...options, consumerGroup, handler };
  assert.equal((await processAsyncConsumerMessage(input, settings)).status, "failed");
  await sleep(30);
  const recreated = createPostgresAsyncTaskStore({ pool });
  const [retry] = await recreated.dueMessages(consumerGroup);
  assert.ok(retry);
  assert.deepEqual(JSON.parse(retry.value).payload, JSON.parse(input.value).payload);
  assert.equal((await processAsyncConsumerMessage(retry, { ...settings, store: recreated })).status, "succeeded");
  assert.equal((await processAsyncConsumerMessage(input, settings)).status, "skipped_duplicate");
  assert.equal((await processAsyncConsumerMessage(message(id, { "\u00e9": 2, "e\u0301": 1 }), settings)).errorCode, "IDEMPOTENCY_CONFLICT");
  assert.equal(executions, 2);
  assert.equal((await recreated.dueMessages(consumerGroup)).length, 0);
});

function legacyHash(task) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return createHash("sha256").update(canonical({ type: task.taskType, payload: task.payload })).digest("hex");
}

async function seedIdentity(input, { status = "failed", compact = false, hash, stored } = {}) {
  const task = parseAsyncTaskMessage(input, group);
  const key = JSON.stringify([group, task.idempotencyKey]);
  hash ??= legacyHash(task);
  await pool.query(
    "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,now())",
    [key, group, hash, compact ? null : JSON.stringify(stored ?? { ...task, status }), status],
  );
  return { task, key, hash };
}

test("legacy failed Unicode JSONB task recovers without rewriting historical receipt identity", async () => {
  const input = message(randomUUID(), { "e\u0301": 2, "\u00e9": 1 });
  const { key, hash } = await seedIdentity(input);
  const recreated = createPostgresAsyncTaskStore({ pool });
  const retry = (await recreated.dueMessages(group, 1000)).find((item) => JSON.parse(item.value).eventId === JSON.parse(input.value).eventId);
  assert.ok(retry);
  assert.notEqual(legacyHash(parseAsyncTaskMessage(retry, group)), hash);
  let executions = 0;
  const settings = { ...options, store: recreated, handler: async () => { executions++; } };
  assert.equal((await processAsyncConsumerMessage(retry, settings)).status, "succeeded");
  assert.equal((await processAsyncConsumerMessage(input, settings)).status, "skipped_duplicate");
  const row = (await pool.query("SELECT request_hash FROM app_idempotency_keys WHERE key=$1", [key])).rows[0];
  const receipt = (await pool.query("SELECT payload_hash FROM app_async_receipts WHERE idempotency_key=$1", [key])).rows[0];
  assert.equal(row.request_hash, hash);
  assert.equal(receipt.payload_hash, hash);
  assert.equal(executions, 1);
});

test("legacy terminal payload proves equality and detects contradictions even when the legacy hash matches", async () => {
  const id = randomUUID();
  const input = message(id, { "e\u0301": 2, "\u00e9": 1 });
  const { key, hash } = await seedIdentity(input, { status: "succeeded" });
  const settings = { ...options, handler: async () => assert.fail("terminal task must not execute") };
  const reordered = message(id, { "\u00e9": 1, "e\u0301": 2 });
  assert.notEqual(legacyHash(parseAsyncTaskMessage(reordered, group)), hash);
  assert.equal((await processAsyncConsumerMessage(reordered, settings)).status, "skipped_duplicate");
  await pool.query("UPDATE app_idempotency_keys SET response_data=jsonb_set(response_data,'{payload}', '{\"changed\":true}') WHERE key=$1", [key]);
  assert.equal((await processAsyncConsumerMessage(input, settings)).errorCode, "IDEMPOTENCY_CONFLICT");
  assert.equal((await pool.query("SELECT request_hash FROM app_idempotency_keys WHERE key=$1", [key])).rows[0].request_hash, hash);
});

test("compacted legacy identities only accept exact old hash matches", async () => {
  const id = randomUUID();
  const input = message(id, { "e\u0301": 2, "\u00e9": 1 });
  await seedIdentity(input, { status: "succeeded", compact: true });
  const settings = { ...options, handler: async () => assert.fail("compacted task must not execute") };
  assert.equal((await processAsyncConsumerMessage(input, settings)).status, "skipped_duplicate");
  for (const payload of [{ "\u00e9": 1, "e\u0301": 2 }, { changed: true }]) {
    const result = await processAsyncConsumerMessage(message(id, payload), settings);
    assert.equal(result.status, "quarantined");
    assert.equal(result.errorCode, "IDEMPOTENCY_UNVERIFIABLE");
  }
});

test("unsupported hashes and incomplete nonterminal stored tasks cannot execute", async () => {
  const settings = { ...options, handler: async () => assert.fail("unverifiable task must not execute") };
  for (const fixture of [
    { hash: `v3:${"0".repeat(64)}` },
    { hash: "invalid" },
    { compact: true },
    { stored: {} },
    { stored: { payload: { value: 1 }, taskType: "demo.echo" } },
  ]) {
    const input = message();
    await seedIdentity(input, fixture);
    assert.equal((await processAsyncConsumerMessage(input, settings)).errorCode, "IDEMPOTENCY_UNVERIFIABLE");
    await pool.query("DELETE FROM app_idempotency_keys WHERE key=$1", [JSON.stringify([group, parseAsyncTaskMessage(input, group).idempotencyKey])]);
  }
  const input = message();
  await seedIdentity(input, { compact: true, hash: payloadHash(parseAsyncTaskMessage(input, group)) });
  assert.equal((await processAsyncConsumerMessage(input, settings)).errorCode, "IDEMPOTENCY_UNVERIFIABLE");
  await pool.query("DELETE FROM app_idempotency_keys WHERE key=$1", [JSON.stringify([group, parseAsyncTaskMessage(input, group).idempotencyKey])]);
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

test("oversized indexed identifiers are quarantined before PostgreSQL claim and acknowledged", async () => {
  for (const [index, field] of ["idempotencyKey", "eventId", "eventType", "traceId", "taskId"].entries()) {
    const input = {
      ...message(randomUUID(), {}, { [field]: randomBytes(4000).toString("hex") }),
      offset: String(index),
      topic: "oversized-identifiers",
    };
    const result = await processAsyncConsumerMessage(input, {
      ...options,
      commitOffset: async () => {
        const durable = await pool.query(
          "SELECT error_code FROM app_message_quarantine WHERE consumer_group=$1 AND topic=$2 AND source_offset=$3",
          [group, input.topic, input.offset],
        );
        assert.equal(durable.rows[0]?.error_code, "INVALID_MESSAGE");
      },
      handler: async () => { assert.fail("oversized message reached handler"); },
    });
    assert.equal(result.status, "quarantined");
    assert.equal(result.committed, true);
  }
});

test("index budget boundary succeeds and legacy serialized terminal keys still deduplicate", async () => {
  const overhead = Buffer.byteLength(JSON.stringify([group, ""]));
  const idempotencyKey = randomBytes(1000).toString("hex").slice(0, 2000 - overhead);
  const input = message(randomUUID(), {}, {
    idempotencyKey,
    eventType: randomBytes(1000).toString("hex"),
    traceId: randomBytes(1000).toString("hex"),
    taskId: randomBytes(1000).toString("hex"),
  });
  const result = await processAsyncConsumerMessage(input, {
    ...options, handler: async () => ({ ok: true }),
  });
  assert.equal(result.status, "succeeded");
  const stored = await pool.query(
    "SELECT octet_length(key) AS bytes FROM app_idempotency_keys WHERE key=$1",
    [JSON.stringify([group, idempotencyKey])],
  );
  assert.equal(stored.rows[0].bytes, 2000);

  const legacyInput = message(randomUUID());
  const task = parseAsyncTaskMessage(legacyInput, group);
  const legacyKey = JSON.stringify([group, task.idempotencyKey]);
  await pool.query(
    "INSERT INTO app_idempotency_keys(key,scope,request_hash,status,expires_at) VALUES($1,$2,$3,'succeeded',now())",
    [legacyKey, group, payloadHash(task)],
  );
  const duplicate = await processAsyncConsumerMessage(legacyInput, {
    ...options, handler: async () => { assert.fail("legacy successful key executed again"); },
  });
  assert.equal(duplicate.status, "skipped_duplicate");
  assert.equal(duplicate.safeToCommit, true);
});

async function seedRecoveryRow(consumerGroup, index, transform = (task) => task) {
  const input = { ...message(`recovery-${index}`), offset: String(index) };
  const task = parseAsyncTaskMessage(input, consumerGroup);
  const key = JSON.stringify([consumerGroup, task.idempotencyKey]);
  await pool.query(
    "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at,created_at,lease_generation) VALUES($1,$2,$3,$4::jsonb,'failed',now()+interval '1 day','2020-01-01'::timestamptz+$5*interval '1 microsecond',7)",
    [key, consumerGroup, payloadHash(task), JSON.stringify(transform(task)), index],
  );
  return { key, task, input };
}

async function recoverySnapshot(key) {
  return (await pool.query("SELECT to_jsonb(task) AS snapshot FROM app_idempotency_keys task WHERE key=$1", [key])).rows[0].snapshot;
}

test("malformed recovery records are durably isolated without changing their original evidence", async () => {
  const consumerGroup = `malformed-${randomUUID()}`;
  const transforms = [
    () => null, () => null, () => 42, () => [],
    (task) => ({ ...task, source: undefined }),
    (task) => ({ ...task, source: { ...task.source, offset: undefined } }),
    (task) => ({ ...task, nextRetryAt: "not-a-date" }),
    (task) => ({ ...task, createdAt: "not-a-date" }),
    (task) => ({ ...task, idempotencyKey: "another-key" }),
    (task) => ({ ...task, source: { ...task.source, offset: { ...task.source.offset, consumerGroup: "another-group" } } }),
  ];
  const invalid = [];
  for (const [index, transform] of transforms.entries()) {
    const row = await seedRecoveryRow(consumerGroup, index, transform);
    invalid.push({ ...row, snapshot: await recoverySnapshot(row.key) });
  }
  await pool.query("UPDATE app_idempotency_keys SET response_data=NULL WHERE key=$1", [invalid[0].key]);
  invalid[0].snapshot = await recoverySnapshot(invalid[0].key);
  await pool.query("UPDATE app_idempotency_keys SET status='processing',lease_until=NULL WHERE key=$1", [invalid[1].key]);
  invalid[1].snapshot = await recoverySnapshot(invalid[1].key);
  await seedRecoveryRow(consumerGroup, 100);
  const fresh = createPostgresAsyncTaskStore({ pool });
  const due = await fresh.dueMessages(consumerGroup, 1);
  assert.equal(due.length, 1);
  assert.equal(JSON.parse(due[0].value).eventId, "recovery-100");
  assert.equal((await processAsyncConsumerMessage(due[0], { ...options, consumerGroup })).status, "succeeded");
  for (const row of invalid) {
    const isolated = (await pool.query("SELECT * FROM app_async_recovery_quarantine WHERE idempotency_key=$1", [row.key])).rows;
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0].consumer_group, consumerGroup);
    assert.equal(isolated[0].error_code, "INVALID_RECOVERY_RECORD");
    assert.deepEqual(isolated[0].original_record, row.snapshot);
    assert.deepEqual(await recoverySnapshot(row.key), row.snapshot);
    assert.equal(await fresh.replay(consumerGroup, row.task.idempotencyKey), false);
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM app_message_quarantine WHERE consumer_group=$1", [consumerGroup])).rows[0].n, 0);
  const restarted = createPostgresAsyncTaskStore({ pool });
  assert.deepEqual(await restarted.dueMessages(consumerGroup), []);
  assert.deepEqual(await fresh.dueMessages(consumerGroup), []);
  const duplicate = await processAsyncConsumerMessage(invalid[0].input, {
    ...options, consumerGroup, store: restarted,
    handler: async () => assert.fail("isolated task must not execute"),
  });
  assert.equal(duplicate.errorCode, "IDEMPOTENCY_UNVERIFIABLE");
  assert.deepEqual(await recoverySnapshot(invalid[0].key), invalid[0].snapshot);
});

test("recovery isolation failure preserves the cursor and retries before later work", async () => {
  const consumerGroup = `isolation-failure-${randomUUID()}`;
  const bad = await seedRecoveryRow(consumerGroup, 0, () => null);
  const snapshot = await recoverySnapshot(bad.key);
  await seedRecoveryRow(consumerGroup, 1);
  const fresh = createPostgresAsyncTaskStore({ pool });
  await pool.query(`
    CREATE FUNCTION reject_recovery_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'recovery isolation unavailable'; END $$;
    CREATE TRIGGER reject_recovery_test BEFORE INSERT ON app_async_recovery_quarantine
    FOR EACH ROW EXECUTE FUNCTION reject_recovery_test();
  `);
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(fresh.dueMessages(consumerGroup, 1), /recovery isolation unavailable/);
    assert.deepEqual(await recoverySnapshot(bad.key), snapshot);
  } finally {
    await pool.query("DROP TRIGGER reject_recovery_test ON app_async_recovery_quarantine; DROP FUNCTION reject_recovery_test()");
  }
  const due = await fresh.dueMessages(consumerGroup, 1);
  assert.equal(due.length, 1);
  assert.equal((await processAsyncConsumerMessage(due[0], { ...options, consumerGroup })).status, "succeeded");
  assert.deepEqual(await fresh.dueMessages(consumerGroup), []);
});

test("bounded recovery scanning reaches due work after a larger future backlog", async () => {
  const consumerGroup = `future-${randomUUID()}`;
  for (let index = 0; index < 205; index++)
    await seedRecoveryRow(consumerGroup, index, (task) => ({ ...task, nextRetryAt: "2999-01-01T00:00:00Z" }));
  await seedRecoveryRow(consumerGroup, 205);
  const fresh = createPostgresAsyncTaskStore({ pool });
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), []);
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), []);
  const due = await fresh.dueMessages(consumerGroup, 1);
  assert.equal(due.length, 1);
  assert.equal(JSON.parse(due[0].value).eventId, "recovery-205");
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), due, "unprocessed due message stays visible");
  assert.equal((await processAsyncConsumerMessage(due[0], { ...options, consumerGroup })).status, "succeeded");
  const restarted = createPostgresAsyncTaskStore({ pool });
  for (let poll = 0; poll < 4; poll++) assert.deepEqual(await restarted.dueMessages(consumerGroup, 1), []);
  assert.equal((await pool.query("SELECT count(*)::int n FROM app_idempotency_keys WHERE scope=$1 AND status='failed'", [consumerGroup])).rows[0].n, 205);
});

test("recovery isolation rechecks a corrected record or active lease under the row lock", async () => {
  for (const activeLease of [false, true]) {
    const consumerGroup = `recheck-${randomUUID()}`;
    const bad = await seedRecoveryRow(consumerGroup, 0, () => null);
    let scanned;
    let resume;
    const observed = new Promise((resolve) => { scanned = resolve; });
    const release = new Promise((resolve) => { resume = resolve; });
    const observingPool = {
      connect: () => pool.connect(),
      async query(sql, parameters) {
        const result = await pool.query(sql, parameters);
        if (sql.includes("SELECT task.created_at::text,task.key,task.response_data")) {
          scanned();
          await release;
        }
        return result;
      },
    };
    const fresh = createPostgresAsyncTaskStore({ pool: observingPool });
    const pending = fresh.dueMessages(consumerGroup, 1);
    await observed;
    try {
      await pool.query(
        "UPDATE app_idempotency_keys SET response_data=$2::jsonb,status=$3,lease_until=$4,locked_by=$5,lease_generation=8 WHERE key=$1",
        [bad.key, JSON.stringify(bad.task), activeLease ? "processing" : "failed", activeLease ? "2999-01-01" : null, activeLease ? "current-owner" : null],
      );
    } finally { resume(); }
    const corrected = await recoverySnapshot(bad.key);
    const due = await pending;
    assert.equal(due.length, activeLease ? 0 : 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM app_async_recovery_quarantine WHERE idempotency_key=$1", [bad.key])).rows[0].n, 0);
    assert.deepEqual(await recoverySnapshot(bad.key), corrected);
    if (!activeLease)
      assert.equal((await processAsyncConsumerMessage(due[0], { ...options, consumerGroup })).status, "succeeded");
  }
});

test("concurrent recovery isolation stays idempotent and its marker blocks corrected-row claim and replay", async () => {
  const consumerGroup = `isolated-marker-${randomUUID()}`;
  const bad = await seedRecoveryRow(consumerGroup, 0, () => null);
  const stores = [createPostgresAsyncTaskStore({ pool }), createPostgresAsyncTaskStore({ pool })];
  assert.deepEqual(await Promise.all(stores.map((current) => current.dueMessages(consumerGroup))), [[], []]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM app_async_recovery_quarantine WHERE idempotency_key=$1", [bad.key])).rows[0].n, 1);
  await pool.query("UPDATE app_idempotency_keys SET response_data=$2::jsonb WHERE key=$1", [bad.key, JSON.stringify(bad.task)]);
  const corrected = await recoverySnapshot(bad.key);
  await assert.rejects(stores[1].claim(bad.task, "duplicate-worker"), /isolated from recovery/);
  assert.equal(await stores[1].replay(consumerGroup, bad.task.idempotencyKey), false);
  assert.deepEqual(await recoverySnapshot(bad.key), corrected);
});

test("recovery keyset scan advances across equal creation timestamps", async () => {
  const consumerGroup = `equal-timestamps-${randomUUID()}`;
  for (let index = 0; index < 105; index++)
    await seedRecoveryRow(consumerGroup, index, (task) => ({ ...task, nextRetryAt: "2999-01-01T00:00:00Z" }));
  await seedRecoveryRow(consumerGroup, 999);
  await pool.query("UPDATE app_idempotency_keys SET created_at='2020-01-01' WHERE scope=$1", [consumerGroup]);
  const fresh = createPostgresAsyncTaskStore({ pool });
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), []);
  const due = await fresh.dueMessages(consumerGroup, 1);
  assert.equal(due.length, 1);
  assert.equal(JSON.parse(due[0].value).eventId, "recovery-999");
});

test("recovery scan wraps despite new future records arriving beyond its cycle boundary", async () => {
  const consumerGroup = `scan-wrap-${randomUUID()}`;
  let first;
  for (let index = 0; index < 102; index++) {
    const row = await seedRecoveryRow(consumerGroup, index, (task) => ({ ...task, nextRetryAt: "2999-01-01T00:00:00Z" }));
    first ??= row;
  }
  const fresh = createPostgresAsyncTaskStore({ pool });
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), []);
  await pool.query("UPDATE app_idempotency_keys SET response_data=response_data-'nextRetryAt' WHERE key=$1", [first.key]);
  for (let index = 102; index < 252; index++)
    await seedRecoveryRow(consumerGroup, index, (task) => ({ ...task, nextRetryAt: "2999-01-01T00:00:00Z" }));
  assert.deepEqual(await fresh.dueMessages(consumerGroup, 1), []);
  const due = await fresh.dueMessages(consumerGroup, 1);
  assert.equal(due.length, 1);
  assert.equal(JSON.parse(due[0].value).eventId, "recovery-0");
});

test("quarantined legacy oversized retries cannot starve later valid durable work", async () => {
  const legacyGroup = `legacy-${randomUUID()}`;
  for (let index = 0; index < 11; index++) {
    const input = { ...message(randomUUID()), offset: String(index) };
    const task = parseAsyncTaskMessage(input, legacyGroup);
    if (index < 10) task.idempotencyKey = `${"x".repeat(4000)}:${index}`;
    await pool.query(
      "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at,created_at) VALUES($1,$2,$3,$4::jsonb,'pending',now(),now()+$5*interval '1 millisecond')",
      [JSON.stringify([legacyGroup, task.idempotencyKey]), legacyGroup, payloadHash(task), JSON.stringify(task), index],
    );
  }
  const first = await store.dueMessages(legacyGroup);
  assert.equal(first.length, 10);
  await pool.query(`
    CREATE FUNCTION reject_quarantine_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'quarantine storage unavailable'; END $$;
    CREATE TRIGGER reject_quarantine_test BEFORE INSERT ON app_message_quarantine
    FOR EACH ROW EXECUTE FUNCTION reject_quarantine_test();
  `);
  let acknowledged = false;
  try {
    await assert.rejects(processAsyncConsumerMessage(first[0], {
      ...options, consumerGroup: legacyGroup,
      commitOffset: async () => { acknowledged = true; },
    }), /quarantine storage unavailable/);
    assert.equal(acknowledged, false);
    assert.equal((await store.dueMessages(legacyGroup)).length, 10);
  } finally {
    await pool.query("DROP TRIGGER reject_quarantine_test ON app_message_quarantine; DROP FUNCTION reject_quarantine_test()");
  }
  for (const input of first) {
    const result = await processAsyncConsumerMessage(input, { ...options, consumerGroup: legacyGroup });
    assert.equal(result.status, "quarantined");
  }
  const next = await store.dueMessages(legacyGroup);
  assert.equal(next.length, 1, "already quarantined legacy entries must leave room for later valid work");
  const result = await processAsyncConsumerMessage(next[0], { ...options, consumerGroup: legacyGroup });
  assert.equal(result.status, "succeeded");
  assert.equal((await store.dueMessages(legacyGroup)).length, 0);
  const preserved = await pool.query(
    "SELECT count(*)::int AS count FROM app_idempotency_keys WHERE scope=$1 AND status='pending' AND length(key)>4000",
    [legacyGroup],
  );
  assert.equal(preserved.rows[0].count, 10);
});

test("unverifiable durable tasks leave the retry window only after quarantine commits", async () => {
  const consumerGroup = `unverifiable-${randomUUID()}`;
  const keys = [];
  for (let index = 0; index < 11; index++) {
    const input = { ...message(), offset: String(index) };
    const task = { ...parseAsyncTaskMessage(input, consumerGroup), status: "failed" };
    const key = JSON.stringify([consumerGroup, task.idempotencyKey]);
    keys.push(key);
    await pool.query(
      "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at,created_at) VALUES($1,$2,$3,$4::jsonb,'failed',now(),now()+$5*interval '1 millisecond')",
      [key, consumerGroup, index < 10 ? `v3:${"a".repeat(64)}` : payloadHash(task), JSON.stringify(task), index],
    );
  }
  const first = await store.dueMessages(consumerGroup);
  assert.equal(first.length, 10);
  const settings = { ...options, consumerGroup };
  await assert.rejects(processAsyncConsumerMessage(first[0], {
    ...settings,
    store: { ...store, quarantine: async () => { throw new Error("quarantine unavailable"); } },
    handler: async () => assert.fail("unverifiable task must not execute"),
  }), /quarantine unavailable/);
  assert.equal((await store.dueMessages(consumerGroup)).length, 10);
  for (const input of first) {
    const result = await processAsyncConsumerMessage(input, {
      ...settings, handler: async () => assert.fail("unverifiable task must not execute"),
    });
    assert.equal(result.errorCode, "IDEMPOTENCY_UNVERIFIABLE");
    assert.equal(result.safeToCommit, true);
  }
  assert.equal(await store.replay(consumerGroup, JSON.parse(keys[0])[1]), true);
  const next = await store.dueMessages(consumerGroup);
  assert.equal(next.length, 1, "quarantine remains effective after replay and permits later work");
  assert.equal((await processAsyncConsumerMessage(next[0], settings)).status, "succeeded");
  assert.equal((await store.dueMessages(consumerGroup)).length, 0);
  const preserved = await pool.query("SELECT request_hash,response_data FROM app_idempotency_keys WHERE key=ANY($1::text[])", [keys.slice(0, 10)]);
  assert.equal(preserved.rows.length, 10);
  for (const row of preserved.rows) {
    assert.equal(row.request_hash, `v3:${"a".repeat(64)}`);
    assert.ok(row.response_data.payload);
  }
});

test("conflict quarantine and other Kafka sources do not hide a recoverable task", async () => {
  const recoveryGroup = `recovery-${randomUUID()}`;
  const input = message();
  const task = parseAsyncTaskMessage(input, recoveryGroup);
  await pool.query(
    "INSERT INTO app_idempotency_keys(key,scope,request_hash,response_data,status,expires_at) VALUES($1,$2,$3,$4::jsonb,'pending',now())",
    [JSON.stringify([recoveryGroup, task.idempotencyKey]), recoveryGroup, payloadHash(task), JSON.stringify(task)],
  );
  await store.quarantine(input, recoveryGroup, "IDEMPOTENCY_CONFLICT", new Error("another payload"));
  for (const [index, code] of ["INVALID_MESSAGE", "IDEMPOTENCY_UNVERIFIABLE"].entries()) {
    for (const extra of [{ topic: `other.topic${index}` }, { partition: index + 1 }, { offset: String(index + 1) }])
      await store.quarantine({ ...input, ...extra }, recoveryGroup, code, new Error("invalid"));
    await store.quarantine(input, `${recoveryGroup}-other${index}`, code, new Error("invalid"));
  }
  const due = await store.dueMessages(recoveryGroup);
  assert.equal(due.length, 1);
  assert.equal((await processAsyncConsumerMessage(due[0], { ...options, consumerGroup: recoveryGroup })).status, "succeeded");
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
        { value: message("long-key", {}, { idempotencyKey: randomBytes(4000).toString("hex") }).value },
        { value: message("after-long-key").value },
        { value: message("after-long-key").value },
      ],
    });
    let afterLongKeyCalls = 0;
    let overdueCalls = 0;
    let calls = 0;
    const offsets = [];
    const runner = await runKafkaConsumer({
      topic,
      brokers,
      groupId: kafkaGroup,
      maxMessages: 10,
      maxWaitMs: 30000,
      eachMessage: async (input) => {
        offsets.push(input.offset);
        return processAsyncConsumerMessage(input, {
          ...options,
          consumerGroup: kafkaGroup,
          now: input.offset === "2" ? new Date(Date.now() - 1000) : undefined,
          handler: async (task) => {
            if (task.sourceEventId === "after-long-key") afterLongKeyCalls++;
            if (task.sourceEventId === id && ++calls === 1)
              throw new Error("retry once");
            if (task.sourceEventId === overdueId && ++overdueCalls === 1)
              throw new Error("overdue retry once");
            return { ok: true };
          },
        });
      },
    });
    assert.equal(runner.processed, 10);
    assert.equal(afterLongKeyCalls, 1);
    assert.equal(calls, 2);
    assert.equal(overdueCalls, 2);
    assert.deepEqual(offsets, ["0", "0", "1", "2", "2", "3", "4", "5", "6", "7", "8", "9"]);
    const quarantined = await pool.query(
      "SELECT source_offset FROM app_message_quarantine WHERE consumer_group=$1 ORDER BY source_offset",
      [kafkaGroup],
    );
    assert.deepEqual(
      quarantined.rows.map((row) => row.source_offset),
      ["1", "3", "4", "5", "7"],
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
    assert.equal(fetched[0].partitions[0].offset, "10");
    const receipt = await pool.query(
      "SELECT idempotency_key FROM app_async_receipts WHERE idempotency_key=$1",
      [JSON.stringify([kafkaGroup, "demo.echo:after-long-key"])],
    );
    assert.equal(receipt.rowCount, 1);
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

test("runtime SIGTERM drains an in-flight receipt transaction and restart skips duplicate execution", { timeout: 90000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { rm } = await import("node:fs/promises");
  const runId = randomUUID();
  const topic = `inflight-${runId}`;
  const consumerGroup = `inflight-${runId}`;
  const key = JSON.stringify([consumerGroup, `demo.echo:${runId}`]);
  const taskId = createHash("sha256").update(key).digest("hex");
  const value = message(runId, { marker: runId }).value;
  const heartbeat = new URL(`./.heartbeat-inflight-${runId}.json`, import.meta.url).pathname;
  const kafka = new Kafka({
    clientId: `inflight-proof-${runId}`,
    brokers: process.env.WORKER_TEST_KAFKA_BROKERS.split(","),
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  const producer = kafka.producer();
  const lock = await pool.connect();
  const children = [];
  async function waitFor(description, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(50);
    }
    assert.fail(`${description}: ${children.map(child => child.stderr).join("\n")}`);
  }
  function startRuntime() {
    const applicationName = `inflight-${children.length}-${runId}`;
    const databaseUrl = new URL(process.env.WORKER_TEST_DATABASE_URL);
    databaseUrl.searchParams.set("application_name", applicationName);
    const processHandle = spawn(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      new URL("../src/index.ts", import.meta.url).pathname,
      "async-runtime", "--interval-ms", "100",
    ], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.toString(),
        KAFKA_BROKERS: process.env.WORKER_TEST_KAFKA_BROKERS,
        OUTBOX_PUBLISHER: "kafka",
        OUTBOX_DRY_RUN: "0",
        ASYNC_RUNTIME_TOPICS: topic,
        KAFKA_CONSUMER_GROUP_ID: consumerGroup,
        WORKER_HEARTBEAT_PATH: heartbeat,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = { processHandle, applicationName, output: "", stderr: "", exited: false };
    child.exit = new Promise(resolve => processHandle.once("exit", (code, signal) => {
      child.exited = true;
      resolve({ code, signal });
    }));
    processHandle.stdout.on("data", data => { child.output = (child.output + data).slice(-16384); });
    processHandle.stderr.on("data", data => { child.stderr = (child.stderr + data).slice(-16384); });
    children.push(child);
    return child;
  }
  async function offset() {
    const offsets = await admin.fetchOffsets({ groupId: consumerGroup, topics: [topic] });
    return offsets[0].partitions[0].offset;
  }
  async function snapshot() {
    return {
      key: (await pool.query("SELECT * FROM app_idempotency_keys WHERE key=$1", [key])).rows,
      task: (await pool.query("SELECT * FROM app_tasks WHERE id=$1", [taskId])).rows,
      receipts: (await pool.query("SELECT * FROM app_async_receipts WHERE idempotency_key=$1", [key])).rows,
      events: (await pool.query("SELECT * FROM app_task_events WHERE task_id=$1 ORDER BY created_at,id", [taskId])).rows,
    };
  }
  async function assertStopped(child) {
    await waitFor("runtime did not drain after SIGTERM", () => child.exited);
    assert.deepEqual(await child.exit, { code: 0, signal: null }, child.stderr);
    const savedHeartbeat = JSON.parse(await readFile(heartbeat, "utf8"));
    assert.equal(savedHeartbeat.pid, child.processHandle.pid);
    assert.equal(savedHeartbeat.state, "stopped");
    assert.equal((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1", [child.applicationName])).rows[0].n, 0);
  }
  try {
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
    await producer.connect();
    const first = startRuntime();
    await waitFor("runtime did not start", () => first.output.includes('"iteration":1'));
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE app_async_receipts IN ACCESS EXCLUSIVE MODE");
    const blockerPid = (await lock.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await producer.send({ topic, messages: [{ value }] });
    const blockedReceipt = () => pool.query(
      `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
       WHERE a.application_name=$1 AND a.state='active' AND a.wait_event_type='Lock'
       AND a.query LIKE 'INSERT INTO "app_async_receipts"%'
       AND l.relation='app_async_receipts'::regclass AND NOT l.granted
       AND $2::int=ANY(pg_blocking_pids(a.pid))`,
      [first.applicationName, blockerPid],
    );
    await waitFor("worker did not block on the owned receipt-table lock", async () => (await blockedReceipt()).rowCount === 1);
    const claimed = (await pool.query("SELECT status,locked_by FROM app_idempotency_keys WHERE key=$1", [key])).rows[0];
    assert.deepEqual(claimed, { status: "processing", locked_by: `worker-${first.processHandle.pid}` });
    assert.ok(BigInt(await offset()) <= 0n, "in-flight event must not have a committed offset");
    assert.equal(first.processHandle.kill("SIGTERM"), true);
    await sleep(500);
    assert.equal(first.exited, false, "SIGTERM must wait for the in-flight database transaction");
    assert.equal((await blockedReceipt()).rowCount, 1, "receipt transaction remains owned while draining");
    assert.notEqual(JSON.parse(await readFile(heartbeat, "utf8")).state, "stopped");
    await lock.query("COMMIT");
    await assertStopped(first);
    const drainedOffset = await offset();
    assert.ok(BigInt(drainedOffset) <= 1n, "offset must not advance beyond durable work");
    t.diagnostic(`Kafka offset after drain: ${drainedOffset}; -1 means no committed offset`);
    const completed = await snapshot();
    assert.equal(completed.key.length, 1);
    assert.equal(completed.key[0].status, "succeeded");
    assert.equal(Number(completed.key[0].lease_generation), 1);
    assert.equal(completed.task.length, 1);
    assert.equal(completed.task[0].status, "succeeded");
    assert.equal(completed.receipts.length, 1);
    assert.deepEqual(completed.receipts[0].result, { kind: "echo", value: { marker: runId } });
    assert.deepEqual(completed.events.map(event => event.status), ["running", "succeeded"]);

    const restarted = startRuntime();
    await waitFor("restarted runtime did not start", () => restarted.output.includes('"iteration":1'));
    await producer.send({ topic, messages: [{ value }] });
    await waitFor("restarted runtime did not commit duplicate offset", async () => await offset() === "2");
    assert.deepEqual(await snapshot(), completed, "duplicate delivery must not claim or execute the task again");
    assert.equal(restarted.processHandle.kill("SIGTERM"), true);
    await assertStopped(restarted);
    assert.equal(await offset(), "2");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    for (const child of children) {
      if (!child.exited) child.processHandle.kill("SIGKILL");
      await child.exit;
    }
    await producer.disconnect();
    await admin.disconnect();
    await rm(heartbeat, { force: true });
  }
});

test("retention compacts worker history while preserving duplicate and conflict protection", async () => {
  const { runRetention } = await import("@pstack/database/repository");
  const { closeDatabase } = await import("@pstack/database/client");
  const previousDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.WORKER_TEST_DATABASE_URL;
  try {
    const input = message(randomUUID(), { "e\u0301": 2, "\u00e9": 1 });
    const legacy = await seedIdentity(message(), { status: "succeeded" });
    await pool.query("UPDATE app_idempotency_keys SET created_at='2000-01-01',expires_at='2000-01-02' WHERE key=$1", [legacy.key]);
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
    const legacyAfter = (await pool.query("SELECT request_hash,response_data FROM app_idempotency_keys WHERE key=$1", [legacy.key])).rows[0];
    assert.equal(legacyAfter.request_hash, legacy.hash);
    assert.deepEqual(legacyAfter.response_data.payload, legacy.task.payload);
    const recreated = createPostgresAsyncTaskStore({ pool });
    assert.equal(
      (
        await processAsyncConsumerMessage(message(JSON.parse(input.value).eventId, { "\u00e9": 1, "e\u0301": 2 }), {
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
