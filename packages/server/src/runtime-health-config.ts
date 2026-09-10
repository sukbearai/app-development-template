import type { AsyncRuntimePlan } from "@pstack/contracts/modules/runtime/contracts";
import { readOutboxHealthThresholds } from "@pstack/contracts/outbox-health";

function positiveIntegerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function buildRuntimePlanFromEnv(env: NodeJS.ProcessEnv = process.env): AsyncRuntimePlan {
  const topics = (
    env.ASYNC_RUNTIME_TOPICS || "app.tasks,telemetry.events,files.events,audit.events"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const brokersConfigured = (env.KAFKA_BROKERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;

  return {
    outboxIntervalMs: positiveIntegerEnv("OUTBOX_POLL_INTERVAL_MS", 5000, env),
    topics,
    publisher: env.ASYNC_RUNTIME_PUBLISHER || env.OUTBOX_PUBLISHER || "unknown",
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

export function readRuntimeHealthConfiguration() {
  return {
    staleLockMs: positiveIntegerEnv("OUTBOX_STALE_LOCK_MS", 300000),
    thresholds: readOutboxHealthThresholds(process.env),
  };
}
