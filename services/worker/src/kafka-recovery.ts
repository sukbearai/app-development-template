import { asyncRuntimeTopics, loadWorkerEnv } from "./env";
import type { Admin } from "kafkajs";
import type { Pool } from "pg";
import type { appKafkaRecovery } from "@pstack/database/schema";
import {
  kafkaCheckpointSchema,
  recoveryAdmin,
  verifyRecoveryTransport,
  validateKafkaHistory,
  type PartitionOffset,
} from "@pstack/kafka/recovery";

export type RecoveryGuard = {
  transportGroup: string;
  check(): Promise<void>;
  beforeMessage(message: { topic: string; partition: number; offset: string }): Promise<void>;
  committed(message: { topic: string; partition: number; offset: string }): void;
  close(): Promise<void>;
};

export async function readReadyKafkaRecovery(pool: Pool) {
  if ((await pool.query("SELECT to_regnamespace('pstack_restore_guard') AS guard")).rows[0].guard)
    throw new Error("Application restore is incomplete; worker startup is blocked");
  const row = (
    await pool.query<
      Pick<
        typeof appKafkaRecovery.$inferSelect,
        "state" | "logicalGroup" | "transportGroup" | "checkpoint"
      >
    >(
      'SELECT state,logical_group AS "logicalGroup",transport_group AS "transportGroup",checkpoint FROM app_kafka_recovery WHERE singleton',
    )
  ).rows[0];
  if (row && row.state !== "ready")
    throw new Error("Kafka recovery is incomplete; worker startup is blocked");
  return row;
}

export async function loadKafkaRecovery(
  pool: Pool,
  logicalGroup: string,
  topics: string[],
  kafkaEnabled: boolean,
  ownedAdmin?: Admin,
  signal?: AbortSignal,
): Promise<RecoveryGuard | undefined> {
  const row = await readReadyKafkaRecovery(pool);
  if (!row || signal?.aborted) return;
  if (!kafkaEnabled)
    throw new Error("Restored Kafka database requires its permanent recovery transport");
  const checkpoint = kafkaCheckpointSchema.parse(row.checkpoint);
  if (row.logicalGroup !== logicalGroup || checkpoint.logicalGroup !== logicalGroup)
    throw new Error("Kafka recovery logical group differs from worker configuration");
  if (
    row.transportGroup === null ||
    !row.transportGroup.startsWith("pstack-recovery-") ||
    row.transportGroup === logicalGroup ||
    row.transportGroup === checkpoint.sourceTransportGroup
  )
    throw new Error("Invalid Kafka recovery transport binding");
  if (
    topics.length !== checkpoint.topics.length ||
    topics.some((topic) => !checkpoint.topics.some((saved) => saved.topic === topic))
  )
    throw new Error("Kafka recovery subscriptions differ from checkpoint");
  const admin = ownedAdmin ?? recoveryAdmin();
  let floors: PartitionOffset[];
  try {
    await admin.connect();
    floors = await verifyRecoveryTransport(admin, checkpoint, row.transportGroup);
  } catch (error) {
    if (!ownedAdmin) {
      try {
        await admin.disconnect();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Kafka recovery initialization and cleanup failed",
        );
      }
    }
    throw error;
  }
  let checks = Promise.resolve();
  function check() {
    checks = checks.then(async () => {
      await verifyRecoveryTransport(admin, checkpoint, row.transportGroup);
      // Keep our own required offsets: KafkaJS writes a default offset on out-of-range.
      await validateKafkaHistory(admin, checkpoint, floors);
    });
    return checks;
  }
  return {
    transportGroup: row.transportGroup,
    check,
    async beforeMessage(message) {
      await check();
      const floor = floors.find(
        (item) => item.topic === message.topic && item.partition === message.partition,
      );
      if (!floor || BigInt(message.offset) < BigInt(floor.nextOffset))
        throw new Error("Kafka recovery received an unexpected partition or rewound offset");
    },
    committed(message) {
      const floor = floors.find(
        (item) => item.topic === message.topic && item.partition === message.partition,
      );
      if (!floor) throw new Error("Kafka recovery committed an unknown partition");
      floor.nextOffset = (BigInt(message.offset) + 1n).toString();
    },
    async close() {
      await checks.catch(() => undefined);
      if (!ownedAdmin) await admin.disconnect();
    },
  };
}

export async function assertKafkaPublishingReady(pool: Pool, ownedAdmin?: Admin): Promise<void> {
  const env = loadWorkerEnv();
  let recovery: RecoveryGuard | undefined;
  try {
    recovery = await loadKafkaRecovery(
      pool,
      env.kafkaConsumerGroupId,
      asyncRuntimeTopics(),
      true,
      ownedAdmin,
    );
  } finally {
    await recovery?.close();
  }
}
