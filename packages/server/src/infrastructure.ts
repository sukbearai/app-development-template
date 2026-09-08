import { env } from "./env";
import { redisCommand } from "./redis-client";
import { probeS3 } from "./s3-client";
import { databaseProbe } from "@pstack/database/repository";
import { Kafka, logLevel } from "kafkajs";
import { readKafkaConfig } from "@pstack/kafka";
type DependencyState = "ok" | "missing" | "not_configured" | "error";
async function probe(
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Readiness waits for completion and deliberately ignores dependency-specific results.
  operation: () => Promise<unknown>,
): Promise<DependencyState> {
  try {
    await operation();
    return "ok";
  } catch {
    return "error";
  }
}
async function probeKafka() {
  const admin = new Kafka({
    ...readKafkaConfig(),
    clientId: "pstack-readiness",
    connectionTimeout: 1500,
    requestTimeout: 2000,
    retry: { retries: 0 },
    logLevel: logLevel.NOTHING,
  }).admin();
  try {
    await admin.connect();
    await admin.listTopics();
  } finally {
    await admin.disconnect();
  }
}
export async function checkInfrastructure() {
  const [database, redis, objectStorage, kafka] = await Promise.all([
    env.DATABASE_URL
      ? probe(databaseProbe)
      : Promise.resolve<DependencyState>("missing"),
    env.RATE_LIMIT_DRIVER === "redis"
      ? env.REDIS_URL
        ? probe(() => redisCommand(env.REDIS_URL!, ["PING"]))
        : Promise.resolve<DependencyState>("missing")
      : Promise.resolve<DependencyState>("not_configured"),
    env.UPLOAD_STORAGE_DRIVER === "s3"
      ? probe(probeS3)
      : Promise.resolve<DependencyState>("not_configured"),
    process.env.OUTBOX_PUBLISHER === "kafka"
      ? process.env.KAFKA_BROKERS
        ? probe(probeKafka)
        : Promise.resolve<DependencyState>("missing")
      : Promise.resolve<DependencyState>("not_configured"),
  ]);
  return { database, redis, objectStorage, kafka };
}
