import { randomUUID } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import { Client } from "pg";

const kafka = await tsImport("../packages/kafka/src/recovery.ts", import.meta.url);
export const parseKafkaRecovery = (value) => kafka.kafkaRecoverySchema.parse(value);

async function withAdmin(action, env = process.env) {
  const admin = kafka.recoveryAdmin(env);
  try {
    await admin.connect();
    return await action(admin);
  } finally {
    await admin.disconnect();
  }
}

export async function captureKafkaRecovery(env = process.env) {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    if (
      (await client.query("SELECT to_regnamespace('pstack_restore_guard') AS guard")).rows[0].guard
    )
      throw new Error("Application restore is incomplete; backup is blocked");
    const exists = (await client.query("SELECT to_regclass('public.app_kafka_recovery') AS name"))
      .rows[0].name;
    const binding = exists
      ? (await client.query("SELECT * FROM app_kafka_recovery")).rows[0]
      : undefined;
    const hasKafkaHistory = (
      await client.query(`SELECT EXISTS(SELECT 1 FROM app_outbox_events WHERE status='published')
      OR EXISTS(SELECT 1 FROM app_async_receipts) OR EXISTS(SELECT 1 FROM app_message_quarantine)
      OR EXISTS(SELECT 1 FROM app_idempotency_keys) AS active`)
    ).rows[0].active;
    if (binding && binding.state !== "ready")
      throw new Error("Kafka recovery database is not ready for backup");
    const enabled = env.OUTBOX_PUBLISHER === "kafka" || binding || hasKafkaHistory;
    if (!enabled) {
      if (env.KAFKA_BROKERS && !env.OUTBOX_PUBLISHER)
        throw new Error(
          "Set OUTBOX_PUBLISHER explicitly when Kafka brokers are configured for backup",
        );
      return { kind: "disabled" };
    }
    if (!env.KAFKA_BROKERS)
      throw new Error("Existing Kafka activity requires Kafka configuration for backup");
    const logical = env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer";
    const topics = (
      env.ASYNC_RUNTIME_TOPICS || "app.tasks,telemetry.events,files.events,audit.events"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (binding && binding.logical_group !== logical)
      throw new Error("Kafka backup logical group differs from restored binding");
    if (binding) {
      const saved = kafka.kafkaCheckpointSchema.parse(binding.checkpoint);
      if (
        topics.length !== saved.topics.length ||
        topics.some((topic) => !saved.topics.some((row) => row.topic === topic))
      )
        throw new Error("Kafka backup subscriptions differ from recovery checkpoint");
    }
    const otherGroups = (
      await client.query(
        `SELECT consumer_group FROM app_async_receipts WHERE consumer_group<>$1
      UNION SELECT consumer_group FROM app_message_quarantine WHERE consumer_group<>$1
      UNION SELECT scope FROM app_idempotency_keys WHERE scope<>$1 LIMIT 1`,
        [logical],
      )
    ).rows;
    if (otherGroups.length)
      throw new Error("Kafka backup supports one logical consumer group per database");
    return await withAdmin(async (admin) => {
      if (binding)
        await kafka.verifyRecoveryTransport(
          admin,
          kafka.kafkaCheckpointSchema.parse(binding.checkpoint),
          binding.transport_group,
        );
      return kafka.captureKafkaCheckpoint(
        admin,
        logical,
        binding?.transport_group || logical,
        topics,
      );
    }, env);
  } finally {
    await client.end();
  }
}

export async function verifyKafkaCheckpointHistory(checkpoint) {
  if (checkpoint.kind === "checkpoint")
    await withAdmin((admin) => kafka.validateKafkaHistory(admin, checkpoint));
}

export function planKafkaRestore(manifest, options) {
  if (options.recoverKafka) {
    if (manifest.version !== 2 || manifest.kafkaRecovery?.kind !== "checkpoint")
      throw new Error("Kafka recovery requires a v2 bundle with a Kafka checkpoint");
    const checkpoint = kafka.kafkaCheckpointSchema.parse(manifest.kafkaRecovery);
    if (
      (process.env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer") !==
      checkpoint.logicalGroup
    )
      throw new Error("Kafka restore logical group differs from checkpoint");
    return { checkpoint, transportGroup: `pstack-recovery-${randomUUID()}` };
  }
  if (
    !options.dataOnly &&
    (manifest.version === 1 ||
      manifest.kafkaRecovery?.kind === "checkpoint" ||
      process.env.OUTBOX_PUBLISHER === "kafka")
  ) {
    throw new Error(
      "Restore requires --recover-kafka, or explicit --data-only without automatic Kafka recovery",
    );
  }
}

export async function installKafkaRecoveryBinding(client, plan) {
  // Commit the blocker separately. A later object or Kafka failure must leave it durable.
  await client.query(
    `INSERT INTO app_kafka_recovery(singleton,state,logical_group,transport_group,checkpoint)
    VALUES(true,'restoring',$1,$2,$3::jsonb) ON CONFLICT(singleton) DO UPDATE
    SET state='restoring',logical_group=EXCLUDED.logical_group,transport_group=EXCLUDED.transport_group,checkpoint=EXCLUDED.checkpoint,created_at=now()`,
    [plan.checkpoint.logicalGroup, plan.transportGroup, JSON.stringify(plan.checkpoint)],
  );
}

export async function initializeKafkaRecovery(plan) {
  await withAdmin((admin) =>
    kafka.initializeRecoveryTransport(admin, plan.checkpoint, plan.transportGroup),
  );
}
