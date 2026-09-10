import { closeDatabase } from "@pstack/database/client";
import { inspectWorkerHeartbeat } from "./heartbeat";
import type { KafkaConsumerOffset } from "@pstack/contracts/async-contracts";
import { createPostgresAsyncTaskStore } from "./async-task-store";
import { processAsyncConsumerMessage } from "./async-consumer";
import { type AsyncConsumerHandler, type ConsumerMessage } from "./async-task";
import { flagEnabled, flagValue, printJson } from "./cli-utils";
import { loadWorkerEnv } from "./env";
import { workerIdentity } from "./worker-identity";
import { logger } from "./logger";
import { runAsyncRuntime, runOutboxLoop } from "./async-runtime";
import { inspectOutboxReadiness } from "./outbox-readiness";
import {
  outboxKafkaMessageValue as buildOutboxKafkaMessageValue,
  processOutboxOnce,
  type OutboxEvent,
} from "./outbox";

type LegacyOutboxRow = {
  id: string;
  topic: string;
  event_type: string;
  trace_id: string;
  payload: unknown;
  attempts: number;
  max_attempts?: number;
};

export function workerHealth() {
  return {
    status: "ok",
    service: "worker",
    supportedCommands: [
      "health",
      "readiness",
      "alerts",
      "outbox-once",
      "outbox-loop",
      "async-runtime",
    ],
    time: new Date().toISOString(),
  };
}

function legacyOutboxRow(row: LegacyOutboxRow): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    eventType: row.event_type,
    traceId: row.trace_id,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts || 5,
  };
}

export function outboxKafkaMessageValue(
  row: LegacyOutboxRow,
  occurredAt = new Date().toISOString(),
) {
  return buildOutboxKafkaMessageValue(legacyOutboxRow(row), occurredAt);
}

export async function publishOutboxOnce(limit = 10) {
  const result = await processOutboxOnce({ batchSize: limit });
  const summary = {
    status: "ok",
    mode: "outbox-once",
    publisher: loadWorkerEnv().outboxPublisher,
    ...result,
  };
  logger.info("outbox batch complete", summary);
  return summary;
}

export function createAsyncConsumerOptions(input: {
  handler: AsyncConsumerHandler;
  consumerGroup?: string;
  workerId?: string;
  commitOffset?: (offset: KafkaConsumerOffset) => Promise<void>;
}) {
  const env = loadWorkerEnv();
  const store = createPostgresAsyncTaskStore({
    databaseUrl: env.databaseUrl,
    ttlHours: env.asyncTaskIdempotencyTtlHours,
  });
  return {
    consumerGroup: input.consumerGroup || env.kafkaConsumerGroupId,
    workerId: workerIdentity(input.workerId),
    defaultMaxAttempts: env.asyncTaskDefaultMaxAttempts,
    retryBaseMs: env.asyncTaskRetryBaseMs,
    retryMaxMs: env.asyncTaskRetryMaxMs,
    store,
    handler: input.handler,
    commitOffset: input.commitOffset,
    close: () => store.close(),
  };
}

export async function processGenericAsyncMessage(
  message: ConsumerMessage,
  handler: AsyncConsumerHandler,
  options: {
    consumerGroup?: string;
    workerId?: string;
    commitOffset?: (offset: KafkaConsumerOffset) => Promise<void>;
  } = {},
) {
  const consumerOptions = createAsyncConsumerOptions({
    ...options,
    handler,
  });
  try {
    return await processAsyncConsumerMessage(message, consumerOptions);
  } finally {
    await consumerOptions.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args = process.argv.slice(2);
  if (args[0] === "--") args = args.slice(1);
  const command = args[0] || "health";
  if (command === "health") {
    (flagEnabled(args, "--live")
      ? inspectWorkerHeartbeat()
      : Promise.resolve({ ...workerHealth(), scope: "command-capabilities" })
    )
      .then((result) => {
        printJson(result);
        if (result.status !== "ok") process.exitCode = 1;
      })
      .catch((error) => {
        logger.error("worker health failed", { error });
        process.exitCode = 1;
      });
  } else if (command === "readiness") {
    inspectOutboxReadiness()
      .then(printJson)
      .catch((error) => {
        logger.error("worker command failed", { command, error });
        process.exitCode = 1;
      });
  } else if (command === "alerts") {
    inspectOutboxReadiness()
      .then((readiness) =>
        printJson({
          service: "worker",
          status: readiness.status,
          mode: "outbox_alerts",
          alerts: readiness.alerts,
          blockedReasons: readiness.blockedReasons,
          checkedAt: readiness.checkedAt,
        }),
      )
      .catch((error) => {
        logger.error("worker command failed", { command, error });
        process.exitCode = 1;
      });
  } else if (command === "replay") {
    const key = flagValue(args, "--key");
    if (!key) throw new Error("replay requires --key");
    const store = createPostgresAsyncTaskStore();
    store
      .replay(loadWorkerEnv().kafkaConsumerGroupId, key)
      .then((replayed) => printJson({ replayed, key }))
      .catch((error) => {
        logger.error("replay failed", { error });
        process.exitCode = 1;
      })
      .finally(() => closeDatabase());
  } else if (command === "outbox-once") {
    const explicitDryRun = flagEnabled(args, "--dry-run") || process.env.OUTBOX_DRY_RUN === "1";
    const env = loadWorkerEnv({ allowMissingPublisher: explicitDryRun });
    processOutboxOnce({
      batchSize: Number(flagValue(args, "--batch-size") || env.outboxBatchSize),
      dryRun: explicitDryRun || env.outboxPublisher === "dry-run",
    })
      .then((result) => logger.info("worker command complete", { command, result }))
      .finally(() => closeDatabase())
      .catch((error) => {
        logger.error("worker command failed", { command, error });
        process.exitCode = 1;
      });
  } else if (command === "outbox-loop") {
    runOutboxLoop(args).catch((error) => {
      logger.error("worker command failed", { command, error });
      process.exitCode = 1;
    });
  } else if (command === "async-runtime") {
    runAsyncRuntime(args).catch((error) => {
      logger.error("worker command failed", { command, error });
      process.exitCode = 1;
    });
  } else {
    logger.error("unknown worker command", { command });
    process.exitCode = 1;
  }
}
