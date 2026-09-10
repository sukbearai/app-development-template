import { Kafka, logLevel, type Consumer } from "kafkajs";
import { readKafkaConfig } from "@pstack/kafka";
import type { RecoveryGuard } from "./kafka-recovery";
import {
  asyncConsumerGroupSchema,
  kafkaConsumerOffsetSchema,
  type AsyncTaskEnvelope,
  type AsyncTaskStatus,
  type KafkaConsumerOffset,
} from "@pstack/contracts/async-contracts";
import {
  parseAsyncTaskMessage,
  failAsyncTask,
  PayloadConflictError,
  PayloadUnverifiableError,
  StaleLeaseError,
  type ConsumerMessage,
  type AsyncConsumerStore,
  type AsyncConsumerHandler,
  type ClaimResult,
} from "./async-task";

export type AsyncConsumerResult = {
  eventId: string;
  taskId: string;
  traceId: string;
  idempotencyKey: string;
  status: AsyncTaskStatus | "skipped_duplicate" | "deferred_retry" | "quarantined";
  committed: boolean;
  safeToCommit: boolean;
  nextRetryAt?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type AsyncConsumerOptions = {
  consumerGroup: string;
  workerId: string;
  now?: Date;
  retryBaseMs?: number;
  retryMaxMs?: number;
  defaultMaxAttempts?: number;
  store: AsyncConsumerStore;
  handler: AsyncConsumerHandler;
  commitOffset?: (offset: KafkaConsumerOffset) => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRetryDelayMs(nextRetryAt: string | undefined, now: Date) {
  if (!nextRetryAt) return 0;
  const retryAt = Date.parse(nextRetryAt);
  if (!Number.isFinite(retryAt)) return 0;
  return Math.max(0, retryAt - now.getTime());
}

export function nextKafkaOffset(offset: string) {
  const value = BigInt(offset);
  return (value + 1n).toString();
}

export async function processAsyncConsumerMessage(
  message: ConsumerMessage,
  options: AsyncConsumerOptions,
): Promise<AsyncConsumerResult> {
  let task: AsyncTaskEnvelope;
  const offset = kafkaConsumerOffsetSchema.parse({
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    consumerGroup: options.consumerGroup,
  });
  async function acknowledge(result: AsyncConsumerResult) {
    if (result.safeToCommit && options.commitOffset) {
      await options.commitOffset(offset);
      result.committed = true;
    }
    return result;
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Invalid messages and failed claims provide arbitrary thrown values for durable quarantine.
  async function quarantine(code: string, error: unknown) {
    await options.store.quarantine(message, options.consumerGroup, code, error);
    return acknowledge({
      eventId: "",
      taskId: "",
      traceId: "",
      idempotencyKey: "",
      status: "quarantined",
      safeToCommit: true,
      committed: false,
      errorCode: code,
    });
  }
  try {
    task = parseAsyncTaskMessage(message, options.consumerGroup, options);
  } catch (error) {
    return quarantine("INVALID_MESSAGE", error);
  }
  let claim: ClaimResult;
  try {
    claim = await options.store.claim(task, options.workerId);
  } catch (error) {
    if (error instanceof PayloadConflictError) return quarantine("IDEMPOTENCY_CONFLICT", error);
    if (error instanceof PayloadUnverifiableError)
      return quarantine("IDEMPOTENCY_UNVERIFIABLE", error);
    throw error;
  }
  const base = {
    eventId: task.sourceEventId,
    taskId: task.taskId,
    traceId: task.traceId,
    idempotencyKey: task.idempotencyKey,
    committed: false,
  };
  if (claim.kind === "terminal")
    return acknowledge({
      ...base,
      status: "skipped_duplicate",
      safeToCommit: true,
    });
  if (claim.kind === "deferred")
    return {
      ...base,
      status: "deferred_retry",
      safeToCommit: false,
      nextRetryAt: claim.nextRetryAt,
    };
  let outcome: AsyncConsumerResult;
  try {
    await options.store.execute(claim.task, options.handler);
    outcome = { ...base, status: "succeeded", safeToCommit: true };
  } catch (error) {
    if (error instanceof StaleLeaseError)
      return {
        ...base,
        status: "deferred_retry",
        safeToCommit: false,
        nextRetryAt: new Date(Date.now() + 100).toISOString(),
      };
    const failed = {
      ...claim.task,
      ...failAsyncTask(claim.task, error, options),
    };
    await options.store.fail(failed);
    outcome = {
      ...base,
      status: failed.status,
      safeToCommit: failed.status === "dead_letter",
      nextRetryAt: failed.nextRetryAt,
      errorCode: failed.errorCode,
      errorMessage: failed.errorMessage,
    };
  }
  // Offset errors propagate without changing the committed domain transaction.
  return acknowledge(outcome);
}

export async function processConsumerMessagesSequentially(
  messages: ConsumerMessage[],
  handler: (message: ConsumerMessage) => Promise<AsyncConsumerResult>,
  commitOffset: (message: ConsumerMessage) => Promise<void>,
  options: {
    now?: () => Date;
    onRetryableFailure?: () => Promise<void> | void;
    onDeferredRetry?: (result: AsyncConsumerResult) => Promise<void> | void;
  } = {},
) {
  let processed = 0;
  for (const message of messages) {
    const result = await handler(message);
    processed++;
    if (result.safeToCommit) await commitOffset(message);
    else {
      if (nextRetryDelayMs(result.nextRetryAt, options.now?.() ?? new Date()) > 0)
        await options.onDeferredRetry?.(result);
      else await options.onRetryableFailure?.();
      return { processed, stoppedOnRetryableFailure: true };
    }
  }
  return { processed, stoppedOnRetryableFailure: false };
}

type KafkaConsumerOptions = {
  topic?: string;
  topics?: string[];
  groupId: string;
  recovery?: RecoveryGuard;
  clientId?: string;
  brokers?: string[];
  maxMessages?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  eachMessage: (message: ConsumerMessage) => Promise<AsyncConsumerResult>;
};

export function createKafkaConsumer(
  options: Pick<KafkaConsumerOptions, "groupId" | "brokers" | "clientId" | "recovery" | "signal">,
) {
  const groupId = asyncConsumerGroupSchema.parse(options.groupId);
  const brokers = options.brokers ?? (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);
  if (!brokers.length) throw new Error("KAFKA_BROKERS is required for Kafka consumers");
  return new Kafka({
    ...readKafkaConfig({ ...process.env, KAFKA_BROKERS: brokers.join(",") }),
    clientId: options.clientId ?? "pstack-worker",
    brokers,
    logLevel: logLevel.NOTHING,
  }).consumer({
    groupId: options.recovery?.transportGroup ?? groupId,
    retry: { restartOnFailure: async () => !options.signal?.aborted },
  });
}

export async function runKafkaConsumer(
  options: KafkaConsumerOptions & {
    consumer?: Consumer;
    onReady?: () => void;
    onFailure?: (cause: unknown) => void;
  },
) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const consumer = options.consumer ?? createKafkaConsumer({ ...options, signal });
  const failures: unknown[] = [];
  const batches = new Set<Promise<void>>();
  let recoveryCheck = Promise.resolve();
  let processed = 0;
  let completed!: () => void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Promise rejection callback; failure values propagate without reinterpretation.
  let failed!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    completed = resolve;
    failed = (cause) => {
      failures.push(cause);
      reject(cause);
      options.onFailure?.(cause);
    };
  });
  void done.catch(() => undefined);
  let joined = false;
  let groupJoined!: () => void;
  const ready = new Promise<void>((resolve) => {
    groupJoined = resolve;
  });
  const removeJoin = consumer.on(consumer.events.GROUP_JOIN, () => {
    joined = true;
    groupJoined();
  });
  const removeCrash = consumer.on(consumer.events.CRASH, (event) => {
    if (!event.payload.restart) failed(event.payload.error);
  });
  const abort = () => completed();
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  running: try {
    if (signal.aborted) break running;
    await consumer.connect();
    if (signal.aborted) break running;
    if (options.recovery) {
      await options.recovery.check();
      if (signal.aborted) break running;
      let checking = false;
      recoveryTimer = setInterval(() => {
        if (checking || signal.aborted) return;
        checking = true;
        recoveryCheck = Promise.resolve(options.recovery?.check())
          .catch(failed)
          .finally(() => {
            checking = false;
          });
      }, 1000);
    }
    await consumer.subscribe({
      topics: options.topics ?? [options.topic ?? "app.tasks"],
      fromBeginning: true,
    });
    if (signal.aborted) break running;
    if (options.maxWaitMs)
      timer = setTimeout(() => failed(new Error("Kafka consumer timed out")), options.maxWaitMs);
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
        if (signal.aborted) return Promise.resolve();
        const operation = (async () => {
          for (const record of batch.messages) {
            if (!isRunning() || isStale() || signal.aborted) return;
            const message = {
              topic: batch.topic,
              partition: batch.partition,
              offset: record.offset,
              value: record.value,
            };
            await options.recovery?.beforeMessage(message);
            while (isRunning() && !isStale() && !signal.aborted) {
              const pendingHeartbeats = new Set<Promise<void>>();
              const heartbeats = setInterval(() => {
                const pending = heartbeat().catch(failed);
                pendingHeartbeats.add(pending);
                void pending.then(() => pendingHeartbeats.delete(pending));
              }, 1000);
              let result: AsyncConsumerResult;
              try {
                result = await options.eachMessage(message);
              } catch (cause) {
                failed(cause);
                throw cause;
              } finally {
                clearInterval(heartbeats);
                await Promise.all(pendingHeartbeats);
              }
              if (isStale()) return;
              if (result.safeToCommit) {
                await options.recovery?.check();
                await consumer.commitOffsets([
                  {
                    topic: batch.topic,
                    partition: batch.partition,
                    offset: nextKafkaOffset(record.offset),
                  },
                ]);
                options.recovery?.committed(message);
                resolveOffset(record.offset);
                processed++;
                await heartbeat();
                if (options.maxMessages && processed >= options.maxMessages) {
                  completed();
                  return;
                }
                break;
              }
              // Retry this exact offset in the same batch, including already-overdue retries.
              const until = Math.max(
                Date.now() + 25,
                Date.parse(result.nextRetryAt ?? "") || Date.now(),
              );
              while (Date.now() < until && isRunning() && !isStale() && !signal.aborted) {
                await sleep(Math.min(250, until - Date.now()));
                await heartbeat();
              }
            }
            if (!isRunning() || isStale() || signal.aborted) return;
          }
        })();
        const pending = operation.catch(failed);
        batches.add(pending);
        void pending.then(() => batches.delete(pending));
        return operation;
      },
    });
    await Promise.race([ready, done]);
    if (joined && !signal.aborted) options.onReady?.();
    await done;
  } catch (cause) {
    failed(cause);
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    if (recoveryTimer) clearInterval(recoveryTimer);
    await Promise.all(batches);
    await recoveryCheck;
    signal.removeEventListener("abort", abort);
    removeCrash();
    removeJoin();
    if (!options.consumer) {
      try {
        await consumer.stop();
      } catch (cause) {
        failed(cause);
      }
      try {
        await consumer.disconnect();
      } catch (cause) {
        failed(cause);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Kafka consumer failed");
  return { processed };
}
