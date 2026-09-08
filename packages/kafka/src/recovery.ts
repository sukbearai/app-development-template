import kafka, { type Admin } from "kafkajs";
import { z } from "zod";
import { readKafkaConfig } from "./index";
import { asyncConsumerGroupSchema } from "@pstack/contracts";
const { ConfigResourceTypes, Kafka } = kafka;

const offset = z.string().regex(/^(0|[1-9][0-9]*)$/);
const group = asyncConsumerGroupSchema;
const partition = z.object({
  topic: z.string().min(1), partition: z.number().int().nonnegative(),
  nextOffset: offset, low: offset, high: offset,
}).strict();
export const kafkaCheckpointSchema = z.object({
  kind: z.literal("checkpoint"), clusterId: z.string().min(1),
  logicalGroup: group, sourceTransportGroup: group,
  partitions: z.array(partition).min(1),
  topics: z.array(z.object({ topic: z.string().min(1), cleanupPolicy: z.literal("delete") }).strict()).min(1),
}).strict().superRefine((value, context) => {
  const names = value.topics.map((row) => row.topic);
  const keys = value.partitions.map((row) => JSON.stringify([row.topic, row.partition]));
  if (new Set(names).size !== names.length || new Set(keys).size !== keys.length ||
      value.partitions.some((row) => !names.includes(row.topic) || BigInt(row.low) > BigInt(row.nextOffset) || BigInt(row.nextOffset) > BigInt(row.high)) ||
      names.some((topic) => !value.partitions.some((row) => row.topic === topic))) {
    context.addIssue({ code: "custom", message: "Invalid Kafka checkpoint topology or bounds" });
  }
});
export const kafkaRecoverySchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("disabled") }).strict(), kafkaCheckpointSchema]);
export type KafkaCheckpoint = z.infer<typeof kafkaCheckpointSchema>;
export type KafkaRecovery = z.infer<typeof kafkaRecoverySchema>;
export type PartitionOffset = Pick<KafkaCheckpoint["partitions"][number], "topic" | "partition" | "nextOffset">;
const key = (row: { topic: string; partition: number }) => JSON.stringify([row.topic, row.partition]);

export function recoveryAdmin(env: NodeJS.ProcessEnv = process.env) {
  return new Kafka(readKafkaConfig(env)).admin();
}

async function inspectLogs(admin: Admin, topics: string[]) {
  const cluster = await admin.describeCluster();
  if (!cluster.clusterId) throw new Error("Kafka cluster identity is unavailable");
  // listTopics first: fetching metadata must not auto-create a missing topic.
  const existing = await admin.listTopics();
  if (topics.some((topic) => !existing.includes(topic))) throw new Error("Kafka recovery topic is missing");
  const configs = await admin.describeConfigs({ resources: topics.map((name) => ({ type: ConfigResourceTypes.TOPIC, name, configNames: ["cleanup.policy"] })), includeSynonyms: false });
  for (const topic of topics) {
    const resource = configs.resources.find((item) => item.resourceName === topic);
    if (!resource || resource.errorCode || resource.configEntries.find((entry) => entry.configName === "cleanup.policy")?.configValue !== "delete") {
      throw new Error(`Kafka recovery requires cleanup.policy=delete: ${topic}`);
    }
  }
  const partitions = (await Promise.all(topics.map(async (topic) => (await admin.fetchTopicOffsets(topic)).map((row) => ({ topic, partition: row.partition, low: offset.parse(row.low), high: offset.parse(row.high) }))))).flat();
  return { clusterId: cluster.clusterId, partitions };
}

export async function readTransportOffsets(admin: Admin, topics: string[], transportGroup: string): Promise<PartitionOffset[]> {
  const offsets = await admin.fetchOffsets({ groupId: transportGroup, topics, resolveOffsets: false });
  return offsets.flatMap(({ topic, partitions }) => partitions.map((row) => ({ topic, partition: row.partition, nextOffset: row.offset })));
}

export async function captureKafkaCheckpoint(admin: Admin, logicalGroup: string, transportGroup: string, topics: string[]): Promise<KafkaCheckpoint> {
  group.parse(logicalGroup); group.parse(transportGroup);
  const committed = await readTransportOffsets(admin, topics, transportGroup);
  const logs = await inspectLogs(admin, topics);
  return kafkaCheckpointSchema.parse({
    kind: "checkpoint", clusterId: logs.clusterId, logicalGroup, sourceTransportGroup: transportGroup,
    topics: topics.map((topic) => ({ topic, cleanupPolicy: "delete" })),
    partitions: logs.partitions.map((row) => {
      const saved = committed.find((item) => key(item) === key(row))?.nextOffset;
      if (saved === undefined) throw new Error(`Kafka partition offset is missing: ${key(row)}`);
      // An uninitialized partition is replayable only if its complete history is retained.
      const nextOffset = saved === "-1" && row.low === "0" ? "0" : offset.parse(saved);
      return { ...row, nextOffset };
    }),
  });
}

export async function validateKafkaHistory(admin: Admin, checkpoint: KafkaCheckpoint, required: PartitionOffset[] = checkpoint.partitions) {
  const logs = await inspectLogs(admin, checkpoint.topics.map((row) => row.topic));
  if (logs.clusterId !== checkpoint.clusterId) throw new Error("Kafka recovery cluster differs from the checkpoint");
  if (logs.partitions.length !== checkpoint.partitions.length || logs.partitions.some((row) => !checkpoint.partitions.some((saved) => key(saved) === key(row)))) throw new Error("Kafka recovery partition topology changed");
  for (const row of required) {
    const log = logs.partitions.find((candidate) => key(candidate) === key(row));
    const saved = checkpoint.partitions.find((candidate) => key(candidate) === key(row));
    const next = BigInt(offset.parse(row.nextOffset));
    if (!log || !saved || next < BigInt(log.low) || next > BigInt(log.high) || BigInt(log.high) < BigInt(saved.high)) {
      throw new Error(`Kafka recovery history unavailable: ${key(row)} next=${row.nextOffset} low=${log?.low} high=${log?.high}`);
    }
  }
}

export async function verifyRecoveryTransport(admin: Admin, checkpoint: KafkaCheckpoint, transportGroup: string) {
  const current = await readTransportOffsets(admin, checkpoint.topics.map((row) => row.topic), transportGroup);
  if (current.length !== checkpoint.partitions.length) throw new Error("Kafka recovery transport offsets are incomplete");
  for (const saved of checkpoint.partitions) {
    const found = current.find((row) => key(row) === key(saved));
    if (!found || !offset.safeParse(found.nextOffset).success || BigInt(found.nextOffset) < BigInt(saved.nextOffset)) {
      throw new Error(`Kafka recovery transport offset missing or reset: ${key(saved)}`);
    }
  }
  const { groups } = await admin.describeGroups([transportGroup]);
  if (groups.length !== 1 || !["Empty", "Stable", "PreparingRebalance", "CompletingRebalance"].includes(groups[0]?.state || "") || groups[0]?.members.length > 1) throw new Error("Kafka recovery requires one transport consumer; group is unavailable or has multiple members");
  await validateKafkaHistory(admin, checkpoint, current);
  return current;
}

export async function initializeRecoveryTransport(admin: Admin, checkpoint: KafkaCheckpoint, transportGroup: string) {
  if (transportGroup === checkpoint.sourceTransportGroup || transportGroup === checkpoint.logicalGroup) throw new Error("Kafka recovery requires a fresh transport group");
  if ((await admin.listGroups()).groups.some((row) => row.groupId === transportGroup)) throw new Error("Kafka recovery transport group already exists");
  const existing = await readTransportOffsets(admin, checkpoint.topics.map((row) => row.topic), transportGroup);
  if (existing.some((row) => row.nextOffset !== "-1")) throw new Error("Kafka recovery transport has existing offsets");
  await validateKafkaHistory(admin, checkpoint);
  for (const { topic } of checkpoint.topics) {
    await admin.setOffsets({ groupId: transportGroup, topic, partitions: checkpoint.partitions.filter((row) => row.topic === topic).map((row) => ({ partition: row.partition, offset: row.nextOffset })) });
  }
  const actual = await verifyRecoveryTransport(admin, checkpoint, transportGroup);
  if (actual.some((row) => row.nextOffset !== checkpoint.partitions.find((saved) => key(saved) === key(row))?.nextOffset)) throw new Error("Kafka recovery transport initialization readback differs");
}
