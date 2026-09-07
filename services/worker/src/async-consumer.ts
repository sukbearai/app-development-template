import { createHash, randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@pstack/database/client";
import {
  asyncTaskEventMessageSchema,
  type AsyncTaskEnvelope,
  type AsyncTaskEventMessage,
  type AsyncTaskKind,
  type AsyncTaskStatus,
  type KafkaConsumerOffset,
} from "@pstack/contracts";

export type ConsumerMessage = {
  topic: string;
  partition: number;
  offset: string;
  value: string | Buffer | null;
};
export type AsyncConsumerResult = {
  eventId: string;
  taskId: string;
  traceId: string;
  idempotencyKey: string;
  status:
    | AsyncTaskStatus
    | "skipped_duplicate"
    | "deferred_retry"
    | "quarantined";
  committed: boolean;
  safeToCommit: boolean;
  nextRetryAt?: string;
  errorCode?: string;
  errorMessage?: string;
};
export type LeasedTask<T = unknown> = AsyncTaskEnvelope<T> & {
  generation: number;
  requestHash: string;
};
export type AsyncConsumerHandler<T = unknown> = (
  task: AsyncTaskEnvelope<T>,
  context: { client: PoolClient },
) => Promise<unknown>;
export type ClaimResult<T> =
  | { kind: "claimed"; task: LeasedTask<T> }
  | { kind: "terminal"; task: AsyncTaskEnvelope<T> }
  | { kind: "deferred"; task: AsyncTaskEnvelope<T>; nextRetryAt: string };
export type AsyncConsumerStore<T = unknown> = {
  claim(task: AsyncTaskEnvelope<T>, workerId: string): Promise<ClaimResult<T>>;
  execute(task: LeasedTask<T>, handler: AsyncConsumerHandler<T>): Promise<void>;
  fail(task: LeasedTask<T>): Promise<void>;
  quarantine(
    message: ConsumerMessage,
    group: string,
    code: string,
    error: unknown,
  ): Promise<void>;
};
export type AsyncConsumerOptions<T = unknown> = {
  consumerGroup: string;
  workerId: string;
  now?: Date;
  retryBaseMs?: number;
  retryMaxMs?: number;
  defaultMaxAttempts?: number;
  store: AsyncConsumerStore<T>;
  handler: AsyncConsumerHandler<T>;
  commitOffset?: (offset: KafkaConsumerOffset) => Promise<void>;
};
export class PayloadConflictError extends Error {}
export class StaleLeaseError extends Error {}

export function quoteIdent(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function retryDelayMs(attempt: number, baseMs = 1000, maxMs = 300000) {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(baseMs * 2 ** (boundedAttempt - 1), maxMs);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextRetryDelayMs(nextRetryAt: string | undefined, now: Date) {
  if (!nextRetryAt) return 0;
  const retryAt = Date.parse(nextRetryAt);
  if (!Number.isFinite(retryAt)) return 0;
  return Math.max(0, retryAt - now.getTime());
}

function stringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Kafka message ${field} is required`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveInteger(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return fallback;
  return value;
}

function parseJsonValue(value: string | Buffer | null) {
  if (value === null) throw new Error("Kafka message value is empty");
  return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
}

export function nextKafkaOffset(offset: string) {
  const value = BigInt(offset);
  return (value + 1n).toString();
}

export function asyncTaskIdempotencyKey(
  message: Pick<
    AsyncTaskEventMessage,
    "eventType" | "eventId" | "idempotencyKey"
  >,
) {
  return message.idempotencyKey || `${message.eventType}:${message.eventId}`;
}

export function parseAsyncTaskMessage<TPayload = unknown>(
  message: ConsumerMessage,
  consumerGroup: string,
  defaults: { now?: Date; defaultMaxAttempts?: number } = {},
): AsyncTaskEnvelope<TPayload> {
  const parsed = asyncTaskEventMessageSchema.parse(
    parseJsonValue(message.value),
  );
  function validateJsonStorage(value: unknown): void {
    if (typeof value === "string") {
      if (value.includes("\u0000"))
        throw new Error(
          "Message contains a null character unsupported by PostgreSQL JSON",
        );
      for (const character of value) {
        const code = character.charCodeAt(0);
        if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
          throw new Error(
            "Message contains an unpaired surrogate unsupported by PostgreSQL JSON",
          );
      }
    }
    if (Array.isArray(value)) value.forEach(validateJsonStorage);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        validateJsonStorage(key);
        validateJsonStorage(item);
      }
  }
  validateJsonStorage(parsed);
  const eventId = stringField(parsed, "eventId");
  const eventType = stringField(parsed, "eventType") as AsyncTaskKind;
  const traceId = stringField(parsed, "traceId");
  const taskId = optionalStringField(parsed, "taskId") || eventId;
  const sourceOffset = {
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    consumerGroup,
  };
  const eventMessage: AsyncTaskEventMessage<TPayload> = {
    eventId,
    eventType,
    traceId,
    taskId,
    idempotencyKey: optionalStringField(parsed, "idempotencyKey"),
    attemptCount: positiveInteger(parsed.attemptCount, 1),
    maxAttempts: positiveInteger(
      parsed.maxAttempts,
      defaults.defaultMaxAttempts || 5,
    ),
    nextRetryAt: optionalStringField(parsed, "nextRetryAt"),
    occurredAt: optionalStringField(parsed, "occurredAt"),
    payload: parsed.payload as TPayload,
  };
  const nowIso = (defaults.now || new Date()).toISOString();
  return {
    taskId: eventMessage.taskId!,
    taskType: eventMessage.eventType,
    traceId: eventMessage.traceId,
    status: "pending",
    payload: eventMessage.payload,
    idempotencyKey: asyncTaskIdempotencyKey(eventMessage),
    attemptCount: eventMessage.attemptCount!,
    maxAttempts: eventMessage.maxAttempts!,
    nextRetryAt: eventMessage.nextRetryAt,
    sourceEventId: eventMessage.eventId,
    source: {
      eventId: eventMessage.eventId,
      eventType: eventMessage.eventType,
      occurredAt: eventMessage.occurredAt,
      offset: sourceOffset,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function failAsyncTask<TPayload>(
  task: AsyncTaskEnvelope<TPayload>,
  error: unknown,
  options: { now?: Date; retryBaseMs?: number; retryMaxMs?: number } = {},
): AsyncTaskEnvelope<TPayload> {
  const attemptCount = task.attemptCount;
  const deadLetter = attemptCount >= task.maxAttempts;
  const now = options.now || new Date();
  const nextAttemptCount = attemptCount + 1;
  const nextRetryAt = new Date(
    now.getTime() +
      retryDelayMs(nextAttemptCount, options.retryBaseMs, options.retryMaxMs),
  ).toISOString();
  return {
    ...task,
    status: deadLetter ? "dead_letter" : "failed",
    attemptCount: deadLetter ? attemptCount : nextAttemptCount,
    nextRetryAt: deadLetter ? now.toISOString() : nextRetryAt,
    errorCode: deadLetter
      ? "ASYNC_TASK_DEAD_LETTER"
      : "ASYNC_TASK_RETRY_PENDING",
    errorMessage: error instanceof Error ? error.message : String(error),
    updatedAt: now.toISOString(),
  };
}

export function payloadHash(
  task: Pick<AsyncTaskEnvelope, "taskType" | "payload">,
) {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }
  return createHash("sha256")
    .update(canonical({ type: task.taskType, payload: task.payload }))
    .digest("hex");
}

export async function processAsyncConsumerMessage<T = unknown>(
  message: ConsumerMessage,
  options: AsyncConsumerOptions<T>,
): Promise<AsyncConsumerResult> {
  let task: AsyncTaskEnvelope<T>;
  const offset = {
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    consumerGroup: options.consumerGroup,
  };
  async function acknowledge(result: AsyncConsumerResult) {
    if (result.safeToCommit && options.commitOffset) {
      await options.commitOffset(offset);
      result.committed = true;
    }
    return result;
  }
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
    task = parseAsyncTaskMessage<T>(message, options.consumerGroup, options);
  } catch (error) {
    return quarantine("INVALID_MESSAGE", error);
  }
  let claim: ClaimResult<T>;
  try {
    claim = await options.store.claim(task, options.workerId);
  } catch (error) {
    if (error instanceof PayloadConflictError)
      return quarantine("IDEMPOTENCY_CONFLICT", error);
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

export function createPostgresAsyncTaskStore<T = unknown>(
  options: {
    pool?: Pool;
    databaseUrl?: string;
    schemaName?: string;
    ttlHours?: number;
    leaseMs?: number;
  } = {},
) {
  if (
    !options.pool &&
    options.databaseUrl &&
    options.databaseUrl !== process.env.DATABASE_URL
  )
    throw new Error("Inject a pool for a database other than DATABASE_URL");
  const pool = options.pool ?? getPool();
  const table = (name: string) =>
    options.schemaName
      ? `${quoteIdent(options.schemaName)}.${quoteIdent(name)}`
      : quoteIdent(name);
  const keys = table("app_idempotency_keys"),
    tasks = table("app_tasks"),
    events = table("app_task_events");
  const leaseMs = options.leaseMs ?? 60000;
  const key = (task: AsyncTaskEnvelope<T>) =>
    JSON.stringify([task.source.offset?.consumerGroup, task.idempotencyKey]);
  async function transaction<R>(
    body: (client: PoolClient) => Promise<R>,
  ): Promise<R> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await body(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function writeTask(client: PoolClient, task: AsyncTaskEnvelope<T>) {
    // Consumer groups own distinct task projections even for the same source task ID.
    const taskId = createHash("sha256").update(key(task)).digest("hex");
    await client.query(
      `INSERT INTO ${tasks} (id,task_type,status,progress,trace_id,object_type,object_id,error_code,message,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'async_task',$6,$7,$8,now(),now())
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, progress=EXCLUDED.progress,error_code=EXCLUDED.error_code,message=EXCLUDED.message,updated_at=now()`,
      [
        taskId,
        task.taskType,
        task.status,
        task.status === "succeeded" ? 100 : 0,
        task.traceId,
        task.taskId,
        task.errorCode,
        task.errorMessage ?? `Async task ${task.status}`,
      ],
    );
    await client.query(
      `INSERT INTO ${events} (id,task_id,trace_id,event_type,status,message,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now())`,
      [
        randomUUID(),
        taskId,
        task.traceId,
        `async_task.${task.status}`,
        task.status,
        task.errorMessage ?? `Async task ${task.status}`,
        JSON.stringify(task),
      ],
    );
  }
  async function requireLease(client: PoolClient, task: LeasedTask<T>) {
    const result = await client.query(
      `SELECT key FROM ${keys} WHERE key=$1 AND status='processing' AND locked_by=$2 AND lease_generation=$3 AND lease_until>now() FOR UPDATE`,
      [key(task), task.lockedBy, task.generation],
    );
    if (result.rows.length !== 1)
      throw new StaleLeaseError("Task lease no longer belongs to this worker");
  }
  async function finish(client: PoolClient, task: LeasedTask<T>) {
    await client.query(
      `UPDATE ${keys} SET status=$2,response_data=$3::jsonb,locked_by=NULL,lease_until=NULL WHERE key=$1`,
      [key(task), task.status, JSON.stringify(task)],
    );
    await writeTask(client, task);
  }
  const store: AsyncConsumerStore<T> & {
    close(): Promise<void>;
    replay(group: string, idempotencyKey: string): Promise<boolean>;
    dueMessages(group: string, limit?: number): Promise<ConsumerMessage[]>;
  } = {
    async claim(incoming, workerId) {
      return transaction(async (client) => {
        const hash = payloadHash(incoming);
        await client.query(
          `INSERT INTO ${keys}(key,scope,request_hash,response_data,status,expires_at) VALUES($1,$2,$3,$4::jsonb,'pending',now()+$5*interval '1 hour') ON CONFLICT(key) DO NOTHING`,
          [
            key(incoming),
            incoming.source.offset?.consumerGroup,
            hash,
            JSON.stringify(incoming),
            options.ttlHours ?? 168,
          ],
        );
        const {
          rows: [row],
        } = await client.query(
          `SELECT *, lease_until>now() AS active_lease FROM ${keys} WHERE key=$1 FOR UPDATE`,
          [key(incoming)],
        );
        if (!row || row.request_hash !== hash)
          throw new PayloadConflictError(
            "Idempotency key is already bound to another payload",
          );
        if (["succeeded", "dead_letter", "canceled"].includes(row.status))
          return { kind: "terminal", task: incoming };
        const stored = row.response_data as AsyncTaskEnvelope<T>;
        if (row.status === "processing" && row.active_lease)
          return {
            kind: "deferred",
            task: stored,
            nextRetryAt: new Date(row.lease_until).toISOString(),
          };
        if (stored.nextRetryAt && Date.parse(stored.nextRetryAt) > Date.now())
          return {
            kind: "deferred",
            task: stored,
            nextRetryAt: stored.nextRetryAt,
          };
        const generation = Number(row.lease_generation) + 1;
        const task: LeasedTask<T> = {
          ...stored,
          status: "running",
          lockedBy: workerId,
          generation,
          requestHash: hash,
          updatedAt: new Date().toISOString(),
        };
        await client.query(
          `UPDATE ${keys} SET status='processing',locked_by=$2,lease_generation=$3,lease_until=now()+$4*interval '1 millisecond',response_data=$5::jsonb WHERE key=$1`,
          [key(task), workerId, generation, leaseMs, JSON.stringify(task)],
        );
        await writeTask(client, task);
        return { kind: "claimed", task };
      });
    },
    async execute(task, handler) {
      await transaction(async (client) => {
        await requireLease(client, task);
        const result = await handler(task, { client });
        await client.query(
          `INSERT INTO ${table("app_async_receipts")}(idempotency_key,task_id,consumer_group,event_type,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            key(task),
            task.taskId,
            task.source.offset?.consumerGroup,
            task.taskType,
            task.requestHash,
            JSON.stringify(result ?? null),
          ],
        );
        await finish(client, {
          ...task,
          status: "succeeded",
          errorCode: undefined,
          errorMessage: undefined,
          nextRetryAt: undefined,
        });
      });
    },
    async fail(task) {
      await transaction(async (client) => {
        await requireLease(client, task);
        await finish(client, task);
      });
    },
    async quarantine(message, group, code, error) {
      await pool.query(
        `INSERT INTO ${table("app_message_quarantine")}(id,consumer_group,topic,partition,source_offset,raw_value,error_code,error_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(consumer_group,topic,partition,source_offset) DO NOTHING`,
        [
          randomUUID(),
          group,
          message.topic,
          message.partition,
          message.offset,
          JSON.stringify(message.value?.toString() ?? null),
          code,
          (error instanceof Error ? error.message : String(error)).replaceAll(
            "\u0000",
            "\\u0000",
          ),
        ],
      );
    },
    async dueMessages(group, limit = 10) {
      const result = await pool.query(
        `SELECT response_data FROM ${keys} WHERE scope=$1 AND ((status IN ('pending','failed') AND COALESCE((response_data->>'nextRetryAt')::timestamptz,'-infinity'::timestamptz)<=now()) OR (status='processing' AND lease_until<=now())) ORDER BY created_at LIMIT $2`,
        [group, limit],
      );
      return result.rows.map((row) => {
        const task = row.response_data as AsyncTaskEnvelope<T>;
        if (!task.source.offset)
          throw new Error("Stored async task has no source offset");
        return {
          ...task.source.offset,
          value: JSON.stringify({
            eventId: task.sourceEventId,
            eventType: task.taskType,
            traceId: task.traceId,
            taskId: task.taskId,
            idempotencyKey: task.idempotencyKey,
            payload: task.payload,
          }),
        };
      });
    },
    async replay(group, idempotencyKey) {
      return transaction(async (client) => {
        const {
          rows: [row],
        } = await client.query(
          `SELECT * FROM ${keys} WHERE key=$1 AND status IN ('failed','dead_letter') FOR UPDATE`,
          [JSON.stringify([group, idempotencyKey])],
        );
        if (!row) return false;
        const task = {
          ...row.response_data,
          status: "pending",
          attemptCount: 1,
          nextRetryAt: undefined,
          errorCode: undefined,
          errorMessage: undefined,
        };
        await client.query(
          `UPDATE ${keys} SET status='pending',response_data=$2::jsonb,lease_generation=lease_generation+1,locked_by=NULL,lease_until=NULL WHERE key=$1`,
          [row.key, JSON.stringify(task)],
        );
        await writeTask(client, task);
        return true;
      });
    },
    async close() {
      /* The process composition root owns the shared pool. */
    },
  };
  return store;
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
      if (
        nextRetryDelayMs(result.nextRetryAt, options.now?.() ?? new Date()) > 0
      )
        await options.onDeferredRetry?.(result);
      else await options.onRetryableFailure?.();
      return { processed, stoppedOnRetryableFailure: true };
    }
  }
  return { processed, stoppedOnRetryableFailure: false };
}

export async function runKafkaConsumer(options: {
  topic?: string;
  topics?: string[];
  groupId: string;
  clientId?: string;
  brokers?: string[];
  maxMessages?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  eachMessage: (message: ConsumerMessage) => Promise<AsyncConsumerResult>;
}) {
  const brokers =
    options.brokers ??
    (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);
  if (!brokers.length)
    throw new Error("KAFKA_BROKERS is required for Kafka consumers");
  const consumer = new Kafka({
    clientId: options.clientId ?? "pstack-worker",
    brokers,
    logLevel: logLevel.NOTHING,
  }).consumer({ groupId: options.groupId });
  let processed = 0;
  let completed!: () => void;
  let failed!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    completed = resolve;
    failed = reject;
  });
  void done.catch(() => undefined);
  const removeCrash = consumer.on(consumer.events.CRASH, (event) => {
    if (!event.payload.restart) failed(event.payload.error);
  });
  const abort = () => completed();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.signal?.aborted) return { processed };
    await consumer.connect();
    await consumer.subscribe({
      topics: options.topics ?? [options.topic ?? "app.tasks"],
      fromBeginning: true,
    });
    if (options.maxWaitMs)
      timer = setTimeout(
        () => failed(new Error("Kafka consumer timed out")),
        options.maxWaitMs,
      );
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({
        batch,
        resolveOffset,
        heartbeat,
        isRunning,
        isStale,
      }) => {
        for (const record of batch.messages) {
          const message = {
            topic: batch.topic,
            partition: batch.partition,
            offset: record.offset,
            value: record.value,
          };
          while (isRunning() && !isStale() && !options.signal?.aborted) {
            const heartbeats = setInterval(() => {
              void heartbeat().catch(failed);
            }, 1000);
            let result: AsyncConsumerResult;
            try {
              result = await options.eachMessage(message);
            } finally {
              clearInterval(heartbeats);
            }
            if (isStale()) return;
            if (result.safeToCommit) {
              await consumer.commitOffsets([
                {
                  topic: batch.topic,
                  partition: batch.partition,
                  offset: nextKafkaOffset(record.offset),
                },
              ]);
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
            while (
              Date.now() < until &&
              isRunning() &&
              !isStale() &&
              !options.signal?.aborted
            ) {
              await sleep(Math.min(250, until - Date.now()));
              await heartbeat();
            }
          }
          if (!isRunning() || isStale() || options.signal?.aborted) return;
        }
      },
    });
    await done;
    return { processed };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    removeCrash();
    try {
      await consumer.stop();
    } finally {
      await consumer.disconnect();
    }
  }
}
