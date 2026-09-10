import { writeSync } from "node:fs";
import { Kafka, logLevel, type Admin } from "kafkajs";
import { flagValue, numberFlag, printJson } from "./cli-utils";
import { createProducer, processOutboxOnce } from "./outbox";
import { closeDatabase, getPool } from "@pstack/database/client";
import {
  createKafkaConsumer,
  processAsyncConsumerMessage,
  runKafkaConsumer,
} from "./async-consumer";
import { createPostgresAsyncTaskStore } from "./async-task-store";
import { handleDomainEvent } from "./domain-handler";
import { createHeartbeatWriter } from "./heartbeat";
import { asyncRuntimeTopics, loadWorkerEnv } from "./env";
import { loadKafkaRecovery, type RecoveryGuard } from "./kafka-recovery";
import { recoveryAdmin } from "@pstack/kafka/recovery";
import { readKafkaConfig } from "@pstack/kafka";
import { workerIdentity } from "./worker-identity";

function positiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function buildAsyncRuntimePlan(args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
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
      consumerGroupId: env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer",
    },
    asyncTask: {
      defaultMaxAttempts: positiveIntegerEnv("ASYNC_TASK_DEFAULT_MAX_ATTEMPTS", 5, env),
      retryBaseMs: positiveIntegerEnv("ASYNC_TASK_RETRY_BASE_MS", 1000, env),
      retryMaxMs: positiveIntegerEnv("ASYNC_TASK_RETRY_MAX_MS", 300000, env),
      idempotencyTtlHours: positiveIntegerEnv("ASYNC_TASK_IDEMPOTENCY_TTL_HOURS", 168, env),
    },
  };
}

function kafkaBrokers() {
  const brokers = (process.env.KAFKA_BROKERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!brokers.length) throw new Error("KAFKA_BROKERS is required for async-runtime");
  return brokers;
}

function createTopicAdmin() {
  const kafka = new Kafka({
    ...readKafkaConfig(),
    brokers: kafkaBrokers(),
    connectionTimeout: 2000,
    requestTimeout: 3000,
    logLevel: logLevel.NOTHING,
    retry: { retries: 1 },
  });
  return kafka.admin();
}

export async function ensureAsyncRuntimeTopics(
  topics: string[],
  ownedAdmin?: Admin,
  signal?: AbortSignal,
) {
  const admin = ownedAdmin ?? createTopicAdmin();
  try {
    await admin.connect();
    if (signal?.aborted) return;
    const configuredPartitions = Number(process.env.ASYNC_RUNTIME_TOPIC_PARTITIONS || 1);
    const numPartitions =
      Number.isFinite(configuredPartitions) && configuredPartitions > 0
        ? Math.floor(configuredPartitions)
        : 1;
    const replicationFactor = Number(process.env.ASYNC_RUNTIME_TOPIC_REPLICATION_FACTOR || 1);
    const existing = new Set(await admin.listTopics());
    if (signal?.aborted) return;
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
    if (!ownedAdmin) await admin.disconnect();
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
  const env = loadWorkerEnv({
    allowMissingPublisher: iterations === 0 || process.env.OUTBOX_DRY_RUN === "1",
  });
  const plan = buildAsyncRuntimePlan(args);
  if (iterations === 0) {
    printJson({ command: "async-runtime", mode: "plan", ...plan });
    return;
  }
  const controller = new AbortController();
  const errors: unknown[] = [];
  const heartbeatWriter = createHeartbeatWriter();
  let progress = Date.now();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function stop() {
    if (deadline) return;
    deadline = setTimeout(() => {
      try {
        writeSync(2, '{"level":"error","message":"worker shutdown deadline exceeded"}\n');
      } finally {
        process.exit(1);
      }
    }, env.workerShutdownTimeoutMs);
    clearInterval(heartbeat);
    controller.abort();
    void heartbeatWriter.write("stopping", progress).catch(fail);
  }
  function fail(cause: unknown) {
    errors.push(cause);
    stop();
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const kafka = env.outboxPublisher === "kafka" && process.env.OUTBOX_DRY_RUN !== "1";
  let producer: ReturnType<typeof createProducer> | undefined;
  let kafkaConsumer: ReturnType<typeof createKafkaConsumer> | undefined;
  let consumer: Promise<void> | undefined;
  let recovery: RecoveryGuard | undefined;
  let admin: Admin | undefined;
  let topicAdmin: Admin | undefined;
  running: try {
    await heartbeatWriter.write("starting", progress);
    if (controller.signal.aborted) break running;
    const pool = getPool();
    const store = createPostgresAsyncTaskStore({
      pool,
      ttlHours: env.asyncTaskIdempotencyTtlHours,
    });
    const consumerOptions = {
      consumerGroup: env.kafkaConsumerGroupId,
      workerId: workerIdentity(),
      store,
      handler: handleDomainEvent,
      defaultMaxAttempts: env.asyncTaskDefaultMaxAttempts,
      retryBaseMs: env.asyncTaskRetryBaseMs,
      retryMaxMs: env.asyncTaskRetryMaxMs,
    };
    await pool.query("SELECT 1");
    if (controller.signal.aborted) break running;
    if (kafka) admin = recoveryAdmin();
    recovery = await loadKafkaRecovery(
      pool,
      env.kafkaConsumerGroupId,
      plan.topics,
      kafka,
      admin,
      controller.signal,
    );
    if (controller.signal.aborted) break running;
    if (kafka) {
      topicAdmin = createTopicAdmin();
      await ensureAsyncRuntimeTopics(plan.topics, topicAdmin, controller.signal);
      if (controller.signal.aborted) break running;
      producer = createProducer();
      await producer.connect();
      if (controller.signal.aborted) break running;
      if (consume) {
        kafkaConsumer = createKafkaConsumer({
          groupId: env.kafkaConsumerGroupId,
          recovery,
          brokers: env.kafkaBrokers,
          signal: controller.signal,
        });
        let ready!: () => void;
        const initialized = new Promise<void>((resolve) => {
          ready = resolve;
        });
        consumer = runKafkaConsumer({
          consumer: kafkaConsumer,
          topics: plan.topics,
          groupId: env.kafkaConsumerGroupId,
          recovery,
          brokers: env.kafkaBrokers,
          signal: controller.signal,
          onReady: ready,
          onFailure: fail,
          eachMessage: async (message) => {
            const result = await processAsyncConsumerMessage(message, consumerOptions);
            progress = Date.now();
            return result;
          },
        }).then(() => undefined, fail);
        await Promise.race([initialized, consumer]);
        if (controller.signal.aborted) break running;
      }
    }
    progress = Date.now();
    await heartbeatWriter.write("running", progress);
    if (controller.signal.aborted) break running;
    heartbeat = setInterval(() => {
      void heartbeatWriter.write("running", progress).catch(fail);
    }, 3000);
    for (
      let iteration = 0;
      !controller.signal.aborted && (iterations === undefined || iteration < iterations);
      iteration++
    ) {
      const result = await processOutboxOnce({
        pool,
        producer,
        kafkaAdmin: admin,
        dryRun: !kafka,
        signal: controller.signal,
        batchSize: env.outboxBatchSize,
      });
      if (consume && kafka && !controller.signal.aborted) {
        await recovery?.check();
        if (!controller.signal.aborted) {
          for (const message of await store.dueMessages(env.kafkaConsumerGroupId)) {
            if (controller.signal.aborted) break;
            await processAsyncConsumerMessage(message, consumerOptions);
          }
        }
      }
      progress = Date.now();
      if (!controller.signal.aborted) await heartbeatWriter.write("running", progress);
      printJson({
        command: consume ? "async-runtime" : "outbox-loop",
        ...result,
        iteration: iteration + 1,
      });
      if (iterations === undefined || iteration + 1 < iterations)
        await pause(plan.outboxIntervalMs, controller.signal);
    }
  } catch (error) {
    fail(error);
  } finally {
    stop();
    await consumer;
    for (const cleanup of [
      () => kafkaConsumer?.stop(),
      () => kafkaConsumer?.disconnect(),
      () => producer?.disconnect(),
      () => recovery?.close(),
      () => topicAdmin?.disconnect(),
      () => admin?.disconnect(),
      () => closeDatabase(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        fail(error);
      }
    }
    try {
      await heartbeatWriter.flush();
    } catch (error) {
      fail(error);
    }
    try {
      await heartbeatWriter.write(errors.length ? "failed" : "stopped", progress);
    } catch (error) {
      fail(error);
    }
  }
  if (errors.length) {
    process.exitCode = 1;
    // Failed disposers can leave sockets alive; retain the original deadline without keeping a closed process alive.
    deadline?.unref();
    throw new AggregateError(errors, "Worker runtime failed");
  }
  clearTimeout(deadline);
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}

export async function runOutboxLoop(args: string[]) {
  await runRuntime(args, false);
}
export async function runAsyncRuntime(args: string[]) {
  await runRuntime(args, true);
}
