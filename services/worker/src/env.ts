import { asyncConsumerGroupSchema } from "@pstack/contracts";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type WorkerEnv = {
  appName: string;
  logLevel: "debug" | "info" | "warn" | "error";
  nodeEnv: string;
  databaseUrl?: string;
  outboxPublisher: "dry-run" | "kafka";
  outboxBatchSize: number;
  workerShutdownTimeoutMs: number;
  outboxRetryDelaySeconds: number;
  outboxRetryBaseMs: number;
  outboxRetryMaxMs: number;
  asyncTaskIdempotencyTtlHours: number;
  asyncTaskDefaultMaxAttempts: number;
  asyncTaskRetryBaseMs: number;
  asyncTaskRetryMaxMs: number;
  kafkaBrokers: string[];
  kafkaClientId: string;
  kafkaConsumerGroupId: string;
};

function unquote(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(file: string, { override = false } = {}) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || (!override && process.env[match[1]] !== undefined)) continue;
    process.env[match[1]] = unquote(match[2]);
  }
}

function loadEnvFiles() {
  if (process.env.APP_TEMPLATE_WORKER_SKIP_ENV_FILES === "1") return;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

  for (const file of [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, "apps/web/.env.local"),
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env.test"),
    path.join(process.cwd(), ".env.test.local"),
  ]) {
    loadEnvFile(file);
  }
}

function positiveInt(name: string, fallback: number, maximum = Infinity) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer${maximum === Infinity ? "" : ` no greater than ${maximum}`}`,
    );
  }
  return value;
}

function outboxPublisher(allowMissingPublisher: boolean) {
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.OUTBOX_PUBLISHER &&
    !allowMissingPublisher
  )
    throw new Error("OUTBOX_PUBLISHER is required in production; use kafka or explicit dry-run");
  const value = process.env.OUTBOX_PUBLISHER || "dry-run";
  if (value !== "dry-run" && value !== "kafka") {
    throw new Error(`Unknown OUTBOX_PUBLISHER: ${value}`);
  }
  return value;
}

function logLevel() {
  const value = process.env.LOG_LEVEL || "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return "info";
}

export function loadWorkerEnv({ allowMissingPublisher = false } = {}): WorkerEnv {
  loadEnvFiles();
  return {
    appName: process.env.APP_NAME || "app-template-worker",
    logLevel: logLevel(),
    nodeEnv: process.env.NODE_ENV || "development",
    databaseUrl: process.env.DATABASE_URL,
    outboxPublisher: outboxPublisher(allowMissingPublisher),
    workerShutdownTimeoutMs: positiveInt("WORKER_SHUTDOWN_TIMEOUT_MS", 30000, 300000),
    outboxBatchSize: positiveInt("OUTBOX_BATCH_SIZE", 10),
    outboxRetryDelaySeconds: positiveInt("OUTBOX_RETRY_DELAY_SECONDS", 60),
    outboxRetryBaseMs: positiveInt("OUTBOX_RETRY_BASE_MS", 1000),
    outboxRetryMaxMs: positiveInt("OUTBOX_RETRY_MAX_MS", 300000),
    asyncTaskIdempotencyTtlHours: positiveInt("ASYNC_TASK_IDEMPOTENCY_TTL_HOURS", 168),
    asyncTaskDefaultMaxAttempts: positiveInt("ASYNC_TASK_DEFAULT_MAX_ATTEMPTS", 5),
    asyncTaskRetryBaseMs: positiveInt("ASYNC_TASK_RETRY_BASE_MS", 1000),
    asyncTaskRetryMaxMs: positiveInt("ASYNC_TASK_RETRY_MAX_MS", 300000),
    kafkaBrokers: (process.env.KAFKA_BROKERS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    kafkaClientId: process.env.KAFKA_CLIENT_ID || "app-template-worker",
    kafkaConsumerGroupId: asyncConsumerGroupSchema.parse(
      process.env.KAFKA_CONSUMER_GROUP_ID || "app-template-worker-consumer",
    ),
  };
}

export const ASYNC_RUNTIME_TOPICS = [
  "app.tasks",
  "telemetry.events",
  "files.events",
  "audit.events",
] as const;

export function asyncRuntimeTopics(env: NodeJS.ProcessEnv = process.env) {
  return (env.ASYNC_RUNTIME_TOPICS || ASYNC_RUNTIME_TOPICS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
