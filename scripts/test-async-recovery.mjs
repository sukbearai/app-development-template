#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, cp } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
import { sha256 } from "./db-backup.mjs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
if (process.argv[2] === "--interrupt-restore") {
  const originalQuery = Client.prototype.query;
  Client.prototype.query = function (...args) {
    if (typeof args[0] === "string" && args[0].startsWith("INSERT INTO app_kafka_recovery")) process.kill(process.pid, "SIGKILL");
    return originalQuery.apply(this, args);
  };
  const { restoreBundle } = await import("./app-backup.mjs");
  await restoreBundle({ directory: process.env.RECOVERY_TEST_BUNDLE, confirm: true, recoverKafka: true });
  throw new Error("Restore did not reach the injected pre-binding interruption");
} else if (process.argv[2] === "--inspect-due") {
  const { createPostgresAsyncTaskStore } = await import("../services/worker/src/async-consumer.ts");
  const { closeDatabase } = await import("../packages/database/src/client.ts");
  const store = createPostgresAsyncTaskStore({ databaseUrl: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await store.dueMessages(process.env.KAFKA_CONSUMER_GROUP_ID))); }
  finally { await closeDatabase(); }
} else if (process.argv[2] === "--publish-with-retention") {
  const { createProducer, processOutboxOnce } = await import("../services/worker/src/outbox.ts");
  const { runKafkaConsumer, createPostgresAsyncTaskStore, processAsyncConsumerMessage } = await import("../services/worker/src/async-consumer.ts");
  const { loadKafkaRecovery } = await import("../services/worker/src/kafka-recovery.ts");
  const { asyncRuntimeTopics } = await import("../services/worker/src/env.ts");
  const { handleDomainEvent } = await import("../services/worker/src/domain-handler.ts");
  const { getPool, closeDatabase } = await import("../packages/database/src/client.ts");
  const { recoveryAdmin } = await import("../packages/kafka/src/recovery.ts");
  const pool = getPool(), group = process.env.KAFKA_CONSUMER_GROUP_ID;
  const admin = recoveryAdmin(), controller = new AbortController();
  let recovery, producer, consumer;
  try {
    await admin.connect();
    recovery = await loadKafkaRecovery(pool, group, asyncRuntimeTopics(), true);
    producer = await createProducer();
    const store = createPostgresAsyncTaskStore({ pool });
    consumer = runKafkaConsumer({
      topics: asyncRuntimeTopics(), groupId: group, recovery,
      brokers: process.env.KAFKA_BROKERS.split(","), signal: controller.signal,
      eachMessage: (message) => processAsyncConsumerMessage(message, { store, consumerGroup: group, handler: handleDomainEvent, workerId: "retention-proof" }),
    });
    void consumer.catch(() => controller.abort());
    const published = await processOutboxOnce({ pool, dryRun: false, batchSize: 2, producer: {
      async send(record) {
        await producer.send(record);
        const event = JSON.parse(record.messages[0].value);
        const end = (await admin.fetchTopicOffsets("app.tasks"))[0].offset;
        const deadline = Date.now() + 30000;
        while (true) {
          controller.signal.throwIfAborted();
          const committed = await admin.fetchOffsets({ groupId: recovery.transportGroup, topics: ["app.tasks"] });
          const receipts = await pool.query("SELECT count(*)::int AS n FROM app_async_receipts WHERE task_id=$1", [event.eventId]);
          if (committed[0].partitions[0].offset === end && receipts.rows[0].n === 1) break;
          assert.ok(Date.now() < deadline, "Consumer must commit the published event before retention advances");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await admin.deleteTopicRecords({ topic: "app.tasks", partitions: [{ partition: 0, offset: end }] });
      },
    } });
    assert.equal(published.published, 2, "Every claim must use current transport offsets after consumer progress and retention");
  } finally {
    controller.abort();
    try { await consumer; }
    finally {
      try { await producer?.disconnect(); }
      finally {
        try { await recovery?.close(); }
        finally { try { await admin.disconnect(); } finally { await closeDatabase(); } }
      }
    }
  }
} else {
  assert.equal(process.argv.length, 2, "Usage: node scripts/test-async-recovery.mjs");
  await proveRecovery();
}

async function proveRecovery() {
  const { Kafka, logLevel } = createRequire(path.join(root, "services/worker/package.json"))("kafkajs");
  const recoveryTools = await tsImport("../packages/kafka/src/recovery.ts", import.meta.url);
  const id = randomBytes(8).toString("hex"), prefix = `pstack-recovery-${id}`;
  const password = randomBytes(24).toString("base64url");
  const postgresImage = process.env.PSTACK_TEST_POSTGRES_IMAGE || "postgres:17-bullseye";
  const kafkaImage = process.env.PSTACK_TEST_KAFKA_IMAGE || "bitnamilegacy/kafka:3.8.0";
  const evidenceRoot = path.join(root, ".verification", "async-recovery");
  await mkdir(evidenceRoot, { recursive: true });
  const output = await mkdtemp(path.join(evidenceRoot, "run-"));
  const log = createWriteStream(path.join(output, "commands.log"), { mode: 0o600 });
  const summary = { source: root, output, postgresImage, kafkaImage, group: prefix, checkpoints: [], status: "running" };
  const containers = [], clients = [], children = new Set();
  let admin, runtime, interrupted = false;
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(DATABASE_|PG|APP_|SESSION_|RATE_LIMIT_|LOGIN_RATE_|REDIS_|KAFKA_|OUTBOX_|ASYNC_|UPLOAD_|OBJECT_STORAGE_|CLICKHOUSE_|BOOTSTRAP_|WORKER_|POSTGRES_)/.test(key)) delete childEnv[key];
  }
  const redact = (value) => String(value).replaceAll(password, "[redacted]");
  function launch(program, args, env = childEnv) {
    if (interrupted) throw new Error("Recovery verification interrupted");
    const child = spawn(program, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; log.write(redact(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += chunk; log.write(redact(chunk)); });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`${program} ${args[0]} failed (${signal || code}): ${redact(stderr.slice(-2000))}`));
      });
    });
    void done.catch(() => undefined);
    return { child, done };
  }
  async function command(program, args, env = childEnv) {
    const running = launch(program, args, env);
    const timer = setTimeout(() => { try { process.kill(-running.child.pid, "SIGKILL"); } catch {} }, 180_000);
    try { return await running.done; } finally { clearTimeout(timer); }
  }
  function onSignal() {
    interrupted = true;
    for (const child of children) try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, onSignal);
  async function until(label, action, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("Recovery verification interrupted");
      if (runtime && (runtime.child.exitCode !== null || runtime.child.signalCode !== null)) await runtime.done;
      try { if (await action()) return; } catch (error) { last = error; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
  }
  async function container(role, image, env, options = []) {
    const name = `${prefix}-${role}`;
    // Register the owned name before launch so cleanup also handles interrupted docker run.
    containers.push(name);
    await command("docker", ["run", "--detach", "--name", name, "--label", `pstack.async-recovery=${id}`,
      ...options, ...Object.keys(env).flatMap((key) => ["--env", key]), image], { ...childEnv, ...env });
    return name;
  }
  async function connect(connectionString) {
    let client;
    await until("PostgreSQL", async () => {
      const candidate = new Client({ connectionString, connectionTimeoutMillis: 1000 });
      try { await candidate.connect(); client = candidate; return true; }
      catch (error) { await candidate.end().catch(() => undefined); throw error; }
    });
    clients.push(client);
    return client;
  }
  async function stopRuntime() {
    if (!runtime) return;
    const running = runtime;
    runtime = undefined;
    try { process.kill(-running.child.pid, "SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { process.kill(-running.child.pid, "SIGKILL"); } catch {} }, 45_000);
    try { await running.done; } finally { clearTimeout(timer); }
  }
  function startRuntime(env) {
    runtime = launch(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "async-runtime"], env);
  }
  async function checkpoint(label, client, env, eventId) {
    const binding = (await client.query("SELECT state,logical_group,transport_group FROM app_kafka_recovery")).rows[0];
    const facts = {
      label, eventId,
      outbox: (await client.query("SELECT id,status,attempts FROM app_outbox_events WHERE id=$1", [eventId])).rows,
      receipts: (await client.query("SELECT task_id,consumer_group,result FROM app_async_receipts WHERE task_id=$1", [eventId])).rows,
      tasks: (await client.query("SELECT object_id,status FROM app_tasks WHERE object_id=$1", [eventId])).rows,
      dueMessages: JSON.parse(await command(process.execPath, ["--import", "tsx", "scripts/test-async-recovery.mjs", "--inspect-due"], env)),
      offsets: await admin.fetchOffsets({ groupId: prefix, topics: ["app.tasks"] }),
      binding,
      recoveryOffsets: binding ? await admin.fetchOffsets({ groupId: binding.transport_group, topics: ["app.tasks"] }) : undefined,
    };
    summary.checkpoints.push(facts);
    console.log(JSON.stringify(facts));
  }
  const enqueue = (client, eventId) => client.query("INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES($1,'app.tasks','demo.echo',$1,$2::jsonb)", [eventId, JSON.stringify({ marker: eventId })]);
  const count = async (client, eventId) => (await client.query("SELECT count(*)::int AS n FROM app_async_receipts WHERE task_id=$1", [eventId])).rows[0].n;
  async function consumed(client, eventId) {
    await until(`receipt for ${eventId}`, async () => await count(client, eventId) === 1);
    await until("Kafka offset committed to log end", async () => {
      const binding = (await client.query("SELECT transport_group FROM app_kafka_recovery WHERE state='ready'")).rows[0];
      const committed = await admin.fetchOffsets({ groupId: binding?.transport_group || prefix, topics: ["app.tasks"] });
      const end = await admin.fetchTopicOffsets("app.tasks");
      return end.every((row) => committed[0]?.partitions.find((part) => part.partition === row.partition)?.offset === row.offset);
    });
  }
  console.log(`Async recovery evidence: ${output}`);
  try {
    const postgres = await container("postgres", postgresImage, { POSTGRES_USER: "app", POSTGRES_PASSWORD: password, POSTGRES_DB: "postgres" }, ["--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data"]);
    const mapping = await command("docker", ["port", postgres, "5432/tcp"]);
    const base = `postgres://app:${password}@127.0.0.1:${mapping.split(":").at(-1)}/`;
    const control = await connect(base + "postgres");
    await control.query("CREATE DATABASE source");
    await control.query("CREATE DATABASE restored");
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const kafkaPort = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await container("kafka", kafkaImage, {
      KAFKA_CFG_NODE_ID: "1", KAFKA_CFG_PROCESS_ROLES: "broker,controller",
      KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:9094",
      KAFKA_CFG_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:9092,EXTERNAL://127.0.0.1:${kafkaPort}`,
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT",
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER", KAFKA_CFG_INTER_BROKER_LISTENER_NAME: "PLAINTEXT",
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093", KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
      KAFKA_CFG_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1", KAFKA_CFG_TRANSACTION_STATE_LOG_MIN_ISR: "1", ALLOW_PLAINTEXT_LISTENER: "yes",
    }, ["--publish", `127.0.0.1:${kafkaPort}:9094`]);
    admin = new Kafka({ clientId: prefix, brokers: [`127.0.0.1:${kafkaPort}`], logLevel: logLevel.NOTHING, retry: { retries: 0 }, connectionTimeout: 1000 }).admin();
    await until("Kafka", async () => { await admin.connect(); await admin.listTopics(); return true; });
    await admin.createTopics({ topics: [{ topic: "app.tasks", numPartitions: 1, replicationFactor: 1 }, { topic: "recovery.extra", numPartitions: 2, replicationFactor: 1 }], waitForLeaders: true });
    const env = {
      ...childEnv, DATABASE_URL: base + "source", APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
      POSTGRES_TOOLS: "docker", POSTGRES_TOOL_IMAGE: postgresImage, UPLOAD_STORAGE_DRIVER: "local", UPLOAD_STORAGE_DIR: path.join(output, "source-uploads"),
      KAFKA_BROKERS: `127.0.0.1:${kafkaPort}`, KAFKA_CLIENT_ID: prefix, KAFKA_CONSUMER_GROUP_ID: prefix, KAFKAJS_NO_PARTITIONER_WARNING: "1",
      OUTBOX_PUBLISHER: "kafka", OUTBOX_POLL_INTERVAL_MS: "100", ASYNC_RUNTIME_TOPICS: "app.tasks,recovery.extra", WORKER_HEARTBEAT_PATH: path.join(output, "heartbeat.json"),
    };
    await command("pnpm", ["--filter", "@pstack/database", "db:migrate"], env);
    const source = await connect(env.DATABASE_URL);
    const anchor = `anchor-${id}`, eventId = `lost-${id}`, external = `external-${id}`, pruned = `pruned-${id}`;
    async function publishDirect(eventIds) {
      const producer = new Kafka({ clientId: prefix, brokers: [`127.0.0.1:${kafkaPort}`], logLevel: logLevel.NOTHING }).producer();
      await producer.connect();
      try { await producer.send({ topic: "app.tasks", messages: eventIds.map((eventId) => ({ key: eventId, value: JSON.stringify({ eventId, eventType: "demo.echo", traceId: eventId, payload: { marker: eventId } }) })) }); }
      finally { await producer.disconnect(); }
    }
    await enqueue(source, anchor);
    startRuntime(env);
    await consumed(source, anchor);
    await stopRuntime();
    await source.query("UPDATE app_idempotency_keys SET created_at='2000-01-01', expires_at='2000-01-02' WHERE scope=$1", [prefix]);
    await source.query("UPDATE app_async_receipts SET created_at='2000-01-01' WHERE task_id=$1", [anchor]);
    await publishDirect([anchor, external]);
    await enqueue(source, eventId);
    await enqueue(source, pruned);
    await command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once"], env);
    await source.query("UPDATE app_outbox_events SET updated_at='2000-01-01' WHERE id=$1", [pruned]);
    await command(process.execPath, ["--import", "tsx", "scripts/history-prune.mjs", "--days", "1", "--apply"], env);
    assert.equal((await source.query("SELECT count(*)::int AS n FROM app_outbox_events WHERE id=$1", [pruned])).rows[0].n, 0);
    assert.equal((await source.query("SELECT response_data FROM app_idempotency_keys WHERE scope=$1", [prefix])).rows[0].response_data, null);
    await checkpoint("snapshot boundary: published, no consumer task", source, env, eventId);
    const boundary = summary.checkpoints.at(-1);
    assert.equal(boundary.outbox[0].status, "published");
    assert.equal(boundary.receipts.length, 0);
    assert.equal(boundary.tasks.length, 0);
    assert.equal(boundary.dueMessages.length, 0);
    const bundle = path.join(output, "bundle");
    await command(process.execPath, ["scripts/app-backup.mjs", "create", "--output", bundle], env);
    await control.query("CREATE DATABASE interrupted");
    const interruptedEnv = { ...env, DATABASE_URL: base + "interrupted", RECOVERY_TEST_BUNDLE: bundle };
    await assert.rejects(command(process.execPath, ["scripts/test-async-recovery.mjs", "--interrupt-restore"], interruptedEnv), /SIGKILL/);
    const interruptedDatabase = await connect(interruptedEnv.DATABASE_URL);
    assert.equal((await interruptedDatabase.query("SELECT count(*)::int AS n FROM app_kafka_recovery")).rows[0].n, 0);
    await assert.rejects(command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "async-runtime", "--iterations", "1"], interruptedEnv), /Application restore is incomplete/);
    const guardedEvent = `guarded-${id}`;
    await enqueue(interruptedDatabase, guardedEvent);
    const guardedBefore = (await interruptedDatabase.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [guardedEvent])).rows;
    const topicBefore = await admin.fetchTopicOffsets("app.tasks");
    await assert.rejects(command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once"], interruptedEnv), /Application restore is incomplete/);
    await command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once", "--dry-run"], interruptedEnv);
    assert.deepEqual((await interruptedDatabase.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [guardedEvent])).rows, guardedBefore);
    assert.deepEqual(await admin.fetchTopicOffsets("app.tasks"), topicBefore);
    await assert.rejects(command(process.execPath, ["scripts/app-backup.mjs", "create", "--output", path.join(output, "interrupted-backup")], interruptedEnv), /Application restore is incomplete/);
    startRuntime(env);
    await consumed(source, eventId);
    await stopRuntime();
    await checkpoint("after snapshot: original consumer completed and committed offset", source, env, eventId);
    const originalOffsets = await admin.fetchOffsets({ groupId: prefix, topics: ["app.tasks"] });
    const restoredEnv = { ...env, DATABASE_URL: base + "restored", UPLOAD_STORAGE_DIR: path.join(output, "restored-uploads") };
    await command(process.execPath, ["scripts/app-backup.mjs", "restore", "--directory", bundle, "--confirm", "--recover-kafka"], restoredEnv);
    const restored = await connect(restoredEnv.DATABASE_URL);
    assert.equal((await restored.query("SELECT to_regnamespace('pstack_restore_guard') IS NULL AS absent")).rows[0].absent, true);
    await checkpoint("restored snapshot with unchanged Kafka group", restored, restoredEnv, eventId);
    for (const phase of ["resume", "restart"]) {
      const probe = `${phase}-${id}`;
      await enqueue(restored, probe);
      startRuntime(restoredEnv);
      await consumed(restored, probe);
      await stopRuntime();
      await checkpoint(`after ${phase}: fresh probe consumed`, restored, restoredEnv, eventId);
    }
    const completionCounts = (await restored.query("SELECT trace_id,count(*)::int AS n FROM app_task_events WHERE event_type='async_task.succeeded' GROUP BY trace_id ORDER BY trace_id")).rows;
    summary.completionCounts = completionCounts;
    assert.deepEqual(await admin.fetchOffsets({ groupId: prefix, topics: ["app.tasks"] }), originalOffsets, "Recovery must not alter the original Kafka group's offsets");
    assert.equal(await count(restored, anchor), 1, "Snapshot's completed anchor must retain one receipt");
    assert.equal(completionCounts.find((row) => row.trace_id === anchor)?.n, 1, "Recovery must not repeat completed anchor execution");
    assert.equal(await count(restored, eventId), 1, "Restored published event must recover its receipt despite Kafka offset already committed after the snapshot");
    assert.equal(completionCounts.find((row) => row.trace_id === eventId)?.n, 1, "Recovered event must complete exactly once across restart");
    for (const event of [external, pruned]) {
      assert.equal(await count(restored, event), 1, "Recovery must include external producers and messages whose outbox was pruned");
      assert.equal(completionCounts.find((row) => row.trace_id === event)?.n, 1);
    }
    assert.deepEqual((await restored.query("SELECT result FROM app_async_receipts WHERE task_id=$1", [anchor])).rows[0].result, {}, "Replayed tombstone must retain its compacted receipt");
    summary.checks = ["exact receipt, external producer, pruned outbox, compacted tombstone, restart, original group unchanged", "SIGKILL after database restore before binding leaves durable gate; worker and backup refuse; successful restore clears gate"];

    const binding = (await restored.query("SELECT * FROM app_kafka_recovery")).rows[0];
    const checkpointData = recoveryTools.kafkaCheckpointSchema.parse(binding.checkpoint);
    assert.equal(checkpointData.partitions.length, 3);
    await assert.rejects(command(process.execPath, ["scripts/app-backup.mjs", "create", "--output", path.join(output, "narrowed-topics")], { ...restoredEnv, ASYNC_RUNTIME_TOPICS: "app.tasks" }), /subscriptions differ/);
    const secondBundle = path.join(output, "second-bundle");
    await command(process.execPath, ["scripts/app-backup.mjs", "create", "--output", secondBundle], restoredEnv);
    const secondManifest = JSON.parse(await readFile(path.join(secondBundle, "bundle.json"), "utf8"));
    assert.equal(secondManifest.kafkaRecovery.sourceTransportGroup, binding.transport_group);
    assert.equal(secondManifest.kafkaRecovery.partitions[0].nextOffset, (await admin.fetchOffsets({ groupId: binding.transport_group, topics: ["app.tasks"] }))[0].partitions[0].offset);
    summary.checks.push("three partitions initialized; subsequent backup captures permanent transport and refuses omitted topics");

    async function expectWorkerFailure(pattern) {
      await assert.rejects(command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "async-runtime", "--iterations", "1"], restoredEnv), pattern);
    }
    await restored.query("UPDATE app_kafka_recovery SET state='restoring'");
    await expectWorkerFailure(/recovery is incomplete/);
    const oneShotEvent = `one-shot-${id}`;
    await enqueue(restored, oneShotEvent);
    const oneShotBefore = (await restored.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [oneShotEvent])).rows;
    const oneShotOffsets = await admin.fetchTopicOffsets("app.tasks");
    await assert.rejects(command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once"], restoredEnv), /recovery is incomplete/);
    await command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once", "--dry-run"], restoredEnv);
    assert.deepEqual((await restored.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [oneShotEvent])).rows, oneShotBefore);
    assert.deepEqual(await admin.fetchTopicOffsets("app.tasks"), oneShotOffsets);
    await restored.query("UPDATE app_kafka_recovery SET state='ready', checkpoint=$1", [{ ...checkpointData, clusterId: "wrong-cluster" }]);
    await assert.rejects(command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once"], restoredEnv), /cluster differs/);
    await command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once", "--dry-run"], { ...restoredEnv, KAFKA_BROKERS: "127.0.0.1:1" });
    assert.deepEqual((await restored.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [oneShotEvent])).rows, oneShotBefore);
    assert.deepEqual(await admin.fetchTopicOffsets("app.tasks"), oneShotOffsets);
    await restored.query("UPDATE app_kafka_recovery SET checkpoint=$1", [checkpointData]);
    await command(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-once"], restoredEnv);
    assert.equal((await restored.query("SELECT status FROM app_outbox_events WHERE id=$1", [oneShotEvent])).rows[0].status, "published");
    startRuntime(restoredEnv);
    await consumed(restored, oneShotEvent);
    await stopRuntime();
    summary.checks.push("one-shot publisher refuses restore marker, incomplete binding, and ready wrong-cluster checkpoint without claims or Kafka writes; dry-run stays read-only; ready binding publishes and consumes");
    await assert.rejects(recoveryTools.validateKafkaHistory(admin, { ...checkpointData, clusterId: "wrong-cluster" }), /cluster differs/);
    await admin.createTopics({ topics: [{ topic: "compacted", numPartitions: 1, replicationFactor: 1, configEntries: [{ name: "cleanup.policy", value: "compact" }] }], waitForLeaders: true });
    await assert.rejects(recoveryTools.captureKafkaCheckpoint(admin, prefix, prefix, ["compacted"]), /cleanup.policy=delete/);
    await assert.rejects(recoveryTools.initializeRecoveryTransport(admin, checkpointData, binding.transport_group), /already exists/);

    const legacyBundle = path.join(output, "legacy-bundle");
    await cp(bundle, legacyBundle, { recursive: true });
    const legacyManifestFile = path.join(legacyBundle, "bundle.json");
    const legacy = JSON.parse(await readFile(legacyManifestFile, "utf8"));
    legacy.version = 1; delete legacy.kafkaRecovery;
    await writeFile(legacyManifestFile, JSON.stringify(legacy));
    await writeFile(path.join(legacyBundle, "COMPLETE"), await sha256(legacyManifestFile) + "\n");
    await assert.rejects(command(process.execPath, ["scripts/app-backup.mjs", "restore", "--directory", legacyBundle, "--confirm", "--recover-kafka"], restoredEnv), /v2 bundle with a Kafka checkpoint/);
    summary.checks.push("interrupted binding, wrong cluster, compacted topic, existing transport, legacy Kafka recovery rejected");

    const loopFirst = `loop-first-${id}`, loopBlocked = `loop-blocked-${id}`;
    await enqueue(restored, loopFirst);
    runtime = launch(process.execPath, ["--import", "tsx", "services/worker/src/index.ts", "outbox-loop"], { ...restoredEnv, OUTBOX_BATCH_SIZE: "1", OUTBOX_POLL_INTERVAL_MS: "1000" });
    await until("outbox-loop first publication", async () => (await restored.query("SELECT status FROM app_outbox_events WHERE id=$1", [loopFirst])).rows[0].status === "published");
    process.kill(-runtime.child.pid, "SIGSTOP");
    const loopOffsets = await admin.fetchOffsets({ groupId: binding.transport_group, topics: ["app.tasks", "recovery.extra"] });
    await admin.deleteGroups([binding.transport_group]);
    await enqueue(restored, loopBlocked);
    const loopBefore = (await restored.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [loopBlocked])).rows;
    const loopLogEnd = await admin.fetchTopicOffsets("app.tasks");
    const failedLoop = runtime; runtime = undefined;
    process.kill(-failedLoop.child.pid, "SIGCONT");
    const loopDeadline = setTimeout(() => { try { process.kill(-failedLoop.child.pid, "SIGKILL"); } catch {} }, 30000);
    try { await assert.rejects(failedLoop.done, /offset missing or reset/); }
    finally { clearTimeout(loopDeadline); }
    assert.deepEqual((await restored.query("SELECT row_to_json(e) snapshot FROM app_outbox_events e WHERE id=$1", [loopBlocked])).rows, loopBefore);
    assert.deepEqual(await admin.fetchTopicOffsets("app.tasks"), loopLogEnd);
    for (const row of loopOffsets) await admin.setOffsets({ groupId: binding.transport_group, topic: row.topic, partitions: row.partitions.map(({ partition, offset }) => ({ partition, offset })) });
    startRuntime(restoredEnv);
    await consumed(restored, loopBlocked);
    await stopRuntime();
    summary.checks.push("running outbox-loop rejects deleted transport before claiming or sending the next event; restored offsets resume publication");

    for (const phase of ["first", "second"]) await enqueue(restored, `retention-progress-${phase}-${id}`);
    await command(process.execPath, ["--import", "tsx", "scripts/test-async-recovery.mjs", "--publish-with-retention"], restoredEnv);
    for (const phase of ["first", "second"]) assert.equal(await count(restored, `retention-progress-${phase}-${id}`), 1);
    summary.checks.push("same batch publishes two events while real consumer commits and retention advances after each send; publisher does not retain stale required offsets");

    const savedOffsets = await admin.fetchOffsets({ groupId: binding.transport_group, topics: ["app.tasks", "recovery.extra"] });
    await admin.deleteGroups([binding.transport_group]);
    await expectWorkerFailure(/offset missing or reset/);
    await admin.setOffsets({ groupId: binding.transport_group, topic: "app.tasks", partitions: savedOffsets[0].partitions.map(({ partition, offset }) => ({ partition, offset })) });
    await expectWorkerFailure(/offset missing or reset/);
    await admin.setOffsets({ groupId: binding.transport_group, topic: "recovery.extra", partitions: savedOffsets[1].partitions.map(({ partition, offset }) => ({ partition, offset })) });
    summary.checks.push("deleted transport offsets fail startup without fallback to original group");

    // Pause a live restored consumer before appending and deleting the next required record.
    // KafkaJS may reset its fetch offset automatically; no later receipt may be committed.
    startRuntime(restoredEnv);
    await until("recovery consumer joined", async () => (await admin.describeGroups([binding.transport_group])).groups[0].members.length === 1);
    process.kill(-runtime.child.pid, "SIGSTOP");
    const lostAt = BigInt(savedOffsets[0].partitions[0].offset);
    const retainedLater = `retained-later-${id}`;
    await publishDirect([`expired-${id}`, retainedLater]);
    await admin.deleteTopicRecords({ topic: "app.tasks", partitions: [{ partition: 0, offset: (lostAt + 1n).toString() }] });
    process.kill(-runtime.child.pid, "SIGCONT");
    const stopped = runtime; runtime = undefined;
    const deadline = setTimeout(() => { try { process.kill(-stopped.child.pid, "SIGKILL"); } catch {} }, 30_000);
    try { await assert.rejects(stopped.done, /history unavailable|offset missing or reset/); }
    finally { clearTimeout(deadline); }
    assert.equal(await count(restored, retainedLater), 0, "Live retention loss must not process a later record after KafkaJS resets offsets");
    await expectWorkerFailure(/history unavailable|offset missing or reset/);
    await assert.rejects(recoveryTools.validateKafkaHistory(admin, checkpointData), /history unavailable/);
    summary.checks.push("retention loss while consumer is live rejects before later business receipt; expired backup rejected");
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = redact(error.message);
    process.exitCode = 1;
    console.error(summary.error);
  } finally {
    const cleanupErrors = [];
    try { await stopRuntime(); } catch (error) { cleanupErrors.push(error.message); }
    try { await admin?.disconnect(); } catch (error) { cleanupErrors.push(error.message); }
    for (const client of clients) await client.end().catch((error) => cleanupErrors.push(error.message));
    // Cleanup remains available after a signal and only addresses this run's random names.
    interrupted = false;
    for (const name of containers.reverse()) {
      try { await writeFile(path.join(output, `${name}.log`), await command("docker", ["logs", name]), { mode: 0o600 }); } catch {}
      try { await command("docker", ["rm", "--force", "--volumes", name]); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (cleanupErrors.length) { summary.cleanupErrors = cleanupErrors; summary.status = "failed"; process.exitCode = 1; }
    await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    await new Promise((resolve) => log.end(resolve));
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, onSignal);
    console.log(`Result: ${summary.status}; summary: ${path.join(output, "summary.json")}`);
  }
}
