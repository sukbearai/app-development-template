import type { Pool } from "pg";
import {
  kafkaCheckpointSchema, recoveryAdmin, verifyRecoveryTransport, validateKafkaHistory,
  type PartitionOffset,
} from "@pstack/kafka/recovery";

export type RecoveryGuard = {
  transportGroup: string;
  check(): Promise<void>;
  beforeMessage(message: { topic: string; partition: number; offset: string }): Promise<void>;
  committed(message: { topic: string; partition: number; offset: string }): void;
  close(): Promise<void>;
};

export async function loadKafkaRecovery(pool: Pool, logicalGroup: string, topics: string[], kafkaEnabled: boolean): Promise<RecoveryGuard | undefined> {
  if ((await pool.query("SELECT to_regnamespace('pstack_restore_guard') AS guard")).rows[0].guard) throw new Error("Application restore is incomplete; worker startup is blocked");
  const row = (await pool.query("SELECT state,logical_group,transport_group,checkpoint FROM app_kafka_recovery WHERE singleton")).rows[0];
  if (!row) return;
  if (row.state !== "ready") throw new Error("Kafka recovery is incomplete; worker startup is blocked");
  if (!kafkaEnabled) throw new Error("Restored Kafka database requires its permanent recovery transport");
  const checkpoint = kafkaCheckpointSchema.parse(row.checkpoint);
  if (row.logical_group !== logicalGroup || checkpoint.logicalGroup !== logicalGroup) throw new Error("Kafka recovery logical group differs from worker configuration");
  if (typeof row.transport_group !== "string" || !row.transport_group.startsWith("pstack-recovery-") || row.transport_group === logicalGroup || row.transport_group === checkpoint.sourceTransportGroup) throw new Error("Invalid Kafka recovery transport binding");
  if (topics.length !== checkpoint.topics.length || topics.some((topic) => !checkpoint.topics.some((saved) => saved.topic === topic))) throw new Error("Kafka recovery subscriptions differ from checkpoint");
  const admin = recoveryAdmin();
  let floors: PartitionOffset[];
  try { await admin.connect(); floors = await verifyRecoveryTransport(admin, checkpoint, row.transport_group); }
  catch (error) { await admin.disconnect(); throw error; }
  let checks = Promise.resolve();
  function check() {
    checks = checks.then(async () => {
      await verifyRecoveryTransport(admin, checkpoint, row.transport_group);
      // Keep our own required offsets: KafkaJS writes a default offset on out-of-range.
      await validateKafkaHistory(admin, checkpoint, floors);
    });
    return checks;
  }
  return {
    transportGroup: row.transport_group,
    check,
    async beforeMessage(message) {
      await check();
      const floor = floors.find((item) => item.topic === message.topic && item.partition === message.partition);
      if (!floor || BigInt(message.offset) < BigInt(floor.nextOffset)) throw new Error("Kafka recovery received an unexpected partition or rewound offset");
    },
    committed(message) {
      const floor = floors.find((item) => item.topic === message.topic && item.partition === message.partition);
      if (!floor) throw new Error("Kafka recovery committed an unknown partition");
      floor.nextOffset = (BigInt(message.offset) + 1n).toString();
    },
    async close() { await checks.catch(() => undefined); await admin.disconnect(); },
  };
}
