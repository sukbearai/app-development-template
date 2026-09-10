import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  asyncTaskEventMessageSchema,
  asyncIdentifierSchema,
  kafkaConsumerOffsetSchema,
  type AsyncTaskEnvelope,
  type AsyncTaskEventMessage,
} from "@pstack/contracts/async-contracts";

export type ConsumerMessage = {
  topic: string;
  partition: number;
  offset: string;
  value: string | Buffer | null;
};

export type LeasedTask = AsyncTaskEnvelope & {
  generation: number;
  requestHash: string;
};

export type AsyncConsumerHandler = (
  task: AsyncTaskEnvelope,
  context: { client: PoolClient },
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Domain handlers return arbitrary receipt data for JSON persistence, never for unchecked property access.
) => Promise<unknown>;

export type ClaimResult =
  | { kind: "claimed"; task: LeasedTask }
  | { kind: "terminal"; task: AsyncTaskEnvelope }
  | { kind: "deferred"; task: AsyncTaskEnvelope; nextRetryAt: string };

export type AsyncConsumerStore = {
  claim(task: AsyncTaskEnvelope, workerId: string): Promise<ClaimResult>;
  execute(task: LeasedTask, handler: AsyncConsumerHandler): Promise<void>;
  fail(task: LeasedTask): Promise<void>;
  quarantine(
    message: ConsumerMessage,
    group: string,
    code: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Quarantine persists diagnostics from arbitrary caught values.
    error: unknown,
  ): Promise<void>;
};

export class PayloadConflictError extends Error {}

export class PayloadUnverifiableError extends Error {}

export class StaleLeaseError extends Error {}

export function retryDelayMs(attempt: number, baseMs = 1000, maxMs = 300000) {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(baseMs * 2 ** (boundedAttempt - 1), maxMs);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- JSON decoding precedes validation by the Kafka event schema.
function parseJsonValue(value: string | Buffer | null): unknown {
  if (value === null) throw new Error("Kafka message value is empty");
  return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
}

export function asyncTaskIdempotencyKey(
  message: Pick<AsyncTaskEventMessage, "eventType" | "eventId" | "idempotencyKey">,
) {
  return message.idempotencyKey || `${message.eventType}:${message.eventId}`;
}

export function parseAsyncTaskMessage(
  message: ConsumerMessage,
  consumerGroup: string,
  defaults: { now?: Date; defaultMaxAttempts?: number } = {},
): AsyncTaskEnvelope {
  const parsed = asyncTaskEventMessageSchema.parse(parseJsonValue(message.value));
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- PostgreSQL JSON storage checks inspect all nested values after envelope parsing.
  function validateJsonStorage(value: unknown): void {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PostgreSQL rejects null characters and unpaired surrogates specifically in JSON strings.
    if (typeof value === "string") {
      if (value.includes("\u0000"))
        throw new Error("Message contains a null character unsupported by PostgreSQL JSON");
      for (const character of value) {
        const code = character.charCodeAt(0);
        if (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
          throw new Error("Message contains an unpaired surrogate unsupported by PostgreSQL JSON");
      }
    }
    if (Array.isArray(value)) value.forEach(validateJsonStorage);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON objects require recursive checks of both property names and values.
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        validateJsonStorage(key);
        validateJsonStorage(item);
      }
  }
  validateJsonStorage(parsed);
  const { eventId, eventType, traceId } = parsed;
  const taskId = parsed.taskId || eventId;
  const sourceOffset = kafkaConsumerOffsetSchema.parse({
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    consumerGroup,
  });
  const eventMessage = {
    eventId,
    eventType,
    traceId,
    taskId,
    idempotencyKey: parsed.idempotencyKey,
    attemptCount: parsed.attemptCount ?? 1,
    maxAttempts: parsed.maxAttempts ?? (defaults.defaultMaxAttempts || 5),
    nextRetryAt: parsed.nextRetryAt,
    occurredAt: parsed.occurredAt,
    payload: parsed.payload,
  };
  const idempotencyKey = asyncTaskIdempotencyKey(eventMessage);
  asyncIdentifierSchema.parse(JSON.stringify([consumerGroup, idempotencyKey]));
  const nowIso = (defaults.now || new Date()).toISOString();
  return {
    taskId: eventMessage.taskId,
    taskType: eventMessage.eventType,
    traceId: eventMessage.traceId,
    status: "pending",
    payload: eventMessage.payload,
    idempotencyKey,
    attemptCount: eventMessage.attemptCount,
    maxAttempts: eventMessage.maxAttempts,
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Handler failures may throw any value; this transition only records its diagnostic text.
  error: unknown,
  options: { now?: Date; retryBaseMs?: number; retryMaxMs?: number } = {},
): AsyncTaskEnvelope<TPayload> {
  const attemptCount = task.attemptCount;
  const deadLetter = attemptCount >= task.maxAttempts;
  const now = options.now || new Date();
  const nextAttemptCount = attemptCount + 1;
  const nextRetryAt = new Date(
    now.getTime() + retryDelayMs(nextAttemptCount, options.retryBaseMs, options.retryMaxMs),
  ).toISOString();
  return {
    ...task,
    status: deadLetter ? "dead_letter" : "failed",
    attemptCount: deadLetter ? attemptCount : nextAttemptCount,
    nextRetryAt: deadLetter ? now.toISOString() : nextRetryAt,
    errorCode: deadLetter ? "ASYNC_TASK_DEAD_LETTER" : "ASYNC_TASK_RETRY_PENDING",
    errorMessage: error instanceof Error ? error.message : String(error),
    updatedAt: now.toISOString(),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical hashing serializes arbitrary JSON payload values without assuming a domain shape.
function canonicalPayload(value: unknown, legacy = false): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalPayload(item, legacy)).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical JSON distinguishes arrays, objects and scalar values before sorting object keys.
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (legacy) entries.sort(([a], [b]) => a.localeCompare(b));
    else entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPayload(item, legacy)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function legacyPayloadHash(task: Pick<AsyncTaskEnvelope, "taskType" | "payload">) {
  return createHash("sha256")
    .update(canonicalPayload({ type: task.taskType, payload: task.payload }, true))
    .digest("hex");
}

export function payloadHash(task: Pick<AsyncTaskEnvelope, "taskType" | "payload">) {
  return `v2:${createHash("sha256")
    .update(canonicalPayload({ type: task.taskType, payload: task.payload }))
    .digest("hex")}`;
}
