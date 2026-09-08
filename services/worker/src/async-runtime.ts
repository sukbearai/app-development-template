import { Kafka, logLevel } from "kafkajs";
import { flagValue, numberFlag, printJson } from "./cli-utils";
import { createProducer, processOutboxOnce } from "./outbox";
import { closeDatabase, getPool } from "@pstack/database/client";
import {
  createPostgresAsyncTaskStore,
  processAsyncConsumerMessage,
  runKafkaConsumer,
} from "./async-consumer";
import { handleDomainEvent } from "./domain-handler";
import { createHeartbeatWriter } from "./heartbeat";
import { loadWorkerEnv } from "./env";
import { loadKafkaRecovery, type RecoveryGuard } from "./kafka-recovery";
import { readKafkaConfig } from "@pstack/kafka";

export const ASYNC_RUNTIME_TOPICS = [
  "app.tasks",
  "telemetry.events",
  "files.events",
  "audit.events",
] as const;

function positiveIntegerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function asyncRuntimeTopics(env: NodeJS.ProcessEnv = process.env) {
  return (env.ASYNC_RUNTIME_TOPICS || ASYNC_RUNTIME_TOPICS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildAsyncRuntimePlan(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  const brokersConfigured = (env.KAFKA_BROKERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;

  return {
    outboxIntervalMs: Number(
      flagValue(args, "--interval-ms") || env.OUTBOX_POLL_INTERVAL_MS || 5000,
    ),
    topics: asyncRuntimeTopics(env),
    publisher: env.OUTBOX_PUBLISHER || "dry-run",
    kafka: {
      brokersConfigured,
      clientId: env.KAFKA_CLIENT_ID || "app-template-worker",
      consumerGroupId:
        env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer",
    },
    asyncTask: {
      defaultMaxAttempts: positiveIntegerEnv(
        "ASYNC_TASK_DEFAULT_MAX_ATTEMPTS",
        5,
        env,
      ),
      retryBaseMs: positiveIntegerEnv("ASYNC_TASK_RETRY_BASE_MS", 1000, env),
      retryMaxMs: positiveIntegerEnv("ASYNC_TASK_RETRY_MAX_MS", 300000, env),
      idempotencyTtlHours: positiveIntegerEnv(
        "ASYNC_TASK_IDEMPOTENCY_TTL_HOURS",
        168,
        env,
      ),
    },
  };
}

function kafkaBrokers() {
  const brokers = (process.env.KAFKA_BROKERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!brokers.length)
    throw new Error("KAFKA_BROKERS is required for async-runtime");
  return brokers;
}

export async function ensureAsyncRuntimeTopics(topics: string[]) {
  const kafka = new Kafka({
    ...readKafkaConfig(),
    brokers: kafkaBrokers(),
    connectionTimeout: 2000,
    requestTimeout: 3000,
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 },
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const configuredPartitions = Number(
      process.env.ASYNC_RUNTIME_TOPIC_PARTITIONS || 1,
    );
    const numPartitions =
      Number.isFinite(configuredPartitions) && configuredPartitions > 0
        ? Math.floor(configuredPartitions)
        : 1;
    const replicationFactor = Number(
      process.env.ASYNC_RUNTIME_TOPIC_REPLICATION_FACTOR || 1,
    );
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((topic) => !existing.has(topic));
    if (missing.length) {
      await admin.createTopics({
        topics: missing.map((topic) => ({
          topic,
          numPartitions,
          replicationFactor,
        })),
        waitForLeaders: false,
      });
    }
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

async function runRuntime(args: string[], consume: boolean) {
  const iterations = numberFlag(args, "--iterations");
  const env = loadWorkerEnv({ allowMissingPublisher: iterations === 0 || process.env.OUTBOX_DRY_RUN === "1" });
  const plan = buildAsyncRuntimePlan(args);
  if (iterations === 0) {
    printJson({ command: "async-runtime", mode: "plan", ...plan });
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const pool = getPool();
  const store = createPostgresAsyncTaskStore({
    pool,
    ttlHours: env.asyncTaskIdempotencyTtlHours,
  });
  const kafka =
    env.outboxPublisher === "kafka" && process.env.OUTBOX_DRY_RUN !== "1";
  let producer: Awaited<ReturnType<typeof createProducer>> | undefined;
  let consumer: Promise<unknown> | undefined;
  let recovery: RecoveryGuard | undefined;
  let failure: unknown;
  let progress = Date.now();
  const heartbeatWriter = createHeartbeatWriter();
  const heartbeat = setInterval(() => {
    void heartbeatWriter.write("running", progress).catch((error) => {
      failure = error;
      stop();
    });
  }, 3000);
  const consumerOptions = {
    consumerGroup: env.kafkaConsumerGroupId,
    workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
    store,
    handler: handleDomainEvent,
    defaultMaxAttempts: env.asyncTaskDefaultMaxAttempts,
    retryBaseMs: env.asyncTaskRetryBaseMs,
    retryMaxMs: env.asyncTaskRetryMaxMs,
  };
  try {
    await pool.query("SELECT 1");
    recovery = await loadKafkaRecovery(pool, env.kafkaConsumerGroupId, plan.topics, kafka);
    if (kafka) {
      await ensureAsyncRuntimeTopics(plan.topics);
      producer = await createProducer();
      if (consume)
        consumer = runKafkaConsumer({
          topics: plan.topics,
          groupId: env.kafkaConsumerGroupId,
          recovery,
          brokers: env.kafkaBrokers,
          signal: controller.signal,
          eachMessage: async (message) => {
            const result = await processAsyncConsumerMessage(
              message,
              consumerOptions,
            );
            progress = Date.now();
            return result;
          },
        }).catch((error) => {
          failure = error;
          stop();
        });
    }
    for (
      let iteration = 0;
      !controller.signal.aborted &&
      (iterations === undefined || iteration < iterations);
      iteration++
    ) {
      const result = await processOutboxOnce({
        pool,
        producer,
        dryRun: !kafka,
        signal: controller.signal,
        batchSize: env.outboxBatchSize,
      });
      if (consume && kafka) {
        await recovery?.check();
        for (const message of await store.dueMessages(
          env.kafkaConsumerGroupId,
        )) {
          if (controller.signal.aborted) break;
          await processAsyncConsumerMessage(message, consumerOptions);
        }
      }
      progress = Date.now();
      await heartbeatWriter.write("running", progress);
      printJson({
        command: consume ? "async-runtime" : "outbox-loop",
        ...result,
        iteration: iteration + 1,
      });
      if (iterations === undefined || iteration + 1 < iterations)
        await pause(plan.outboxIntervalMs, controller.signal);
    }
    if (failure) throw failure;
  } finally {
    stop();
    clearInterval(heartbeat);
    try {
      await consumer;
    } finally {
      try {
        await producer?.disconnect();
      } finally {
        try {
          try { await recovery?.close(); }
          finally { await closeDatabase(); }
        } finally {
          process.removeListener("SIGTERM", stop);
          process.removeListener("SIGINT", stop);
          await heartbeatWriter.write("stopped", progress);
        }
      }
    }
  }
}

export async function runOutboxLoop(args: string[]) {
  await runRuntime(args, false);
}
export async function runAsyncRuntime(args: string[]) {
  await runRuntime(args, true);
}
