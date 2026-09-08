import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";
import { readKafkaConfig } from "@pstack/kafka";
import type { RecoveryGuard } from "./kafka-recovery";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@pstack/database/client";
import {
  asyncTaskEventMessageSchema,
  asyncTaskStatusSchema,
  asyncIdentifierSchema,
  asyncConsumerGroupSchema,
  kafkaConsumerOffsetSchema,
  type AsyncTaskEnvelope,
  type AsyncTaskEventMessage,
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
export class PayloadConflictError extends Error {}
export class PayloadUnverifiableError extends Error {}
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

// oxlint-disable-next-line anti-slop/no-unknown-returns -- JSON decoding precedes validation by the Kafka event schema.
function parseJsonValue(value: string | Buffer | null): unknown {
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

export function parseAsyncTaskMessage(
  message: ConsumerMessage,
  consumerGroup: string,
  defaults: { now?: Date; defaultMaxAttempts?: number } = {},
): AsyncTaskEnvelope {
  const parsed = asyncTaskEventMessageSchema.parse(
    parseJsonValue(message.value),
  );
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- PostgreSQL JSON storage checks inspect all nested values after envelope parsing.
  function validateJsonStorage(value: unknown): void {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- PostgreSQL rejects null characters and unpaired surrogates specifically in JSON strings.
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical hashing serializes arbitrary JSON payload values without assuming a domain shape.
function canonicalPayload(value: unknown, legacy = false): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalPayload(item, legacy)).join(",")}]`;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Canonical JSON distinguishes arrays, objects and scalar values before sorting object keys.
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (legacy) entries.sort(([a], [b]) => a.localeCompare(b));
    else entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPayload(item, legacy)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function legacyPayloadHash(task: Pick<AsyncTaskEnvelope, "taskType" | "payload">) {
  return createHash("sha256")
    .update(canonicalPayload({ type: task.taskType, payload: task.payload }, true))
    .digest("hex");
}

export function payloadHash(
  task: Pick<AsyncTaskEnvelope, "taskType" | "payload">,
) {
  return `v2:${createHash("sha256")
    .update(canonicalPayload({ type: task.taskType, payload: task.payload }))
    .digest("hex")}`;
}

const storedDateSchema = z.string().refine((date) => Number.isFinite(Date.parse(date)));
const storedIdentifierSchema = z.string().refine((value) => asyncIdentifierSchema.safeParse(value).success);
const legacyStoredIdentifierSchema = z.string().refine((value) => value.trim() !== "");
const storedSourceSchema = z.looseObject({
  offset: kafkaConsumerOffsetSchema.loose(),
  eventId: z.string(),
  eventType: z.string(),
  occurredAt: storedDateSchema.optional(),
});
function storedEnvelopeSchema(allowLegacyIdentifiers: boolean) {
  const identifier = allowLegacyIdentifiers ? legacyStoredIdentifierSchema : storedIdentifierSchema;
  return z.looseObject({
    taskId: identifier,
    taskType: identifier,
    traceId: identifier,
    status: asyncTaskStatusSchema,
    payload: z.unknown(),
    idempotencyKey: identifier,
    sourceEventId: identifier,
    attemptCount: z.number().refine((count) => Number.isInteger(count) && count > 0),
    maxAttempts: z.number().refine((count) => Number.isInteger(count) && count > 0),
    createdAt: storedDateSchema,
    updatedAt: storedDateSchema,
    nextRetryAt: storedDateSchema.optional(),
    source: z.looseObject({}),
  }).refine((record) => Object.hasOwn(record, "payload"));
}
const strictStoredEnvelopeSchema = storedEnvelopeSchema(false);
const legacyStoredEnvelopeSchema = storedEnvelopeSchema(true);
const storedMetadataSchema = z.object({
  lockedBy: z.string().optional(),
  lockedUntil: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Recovery reads untrusted persisted JSON and validates the storage envelope before using it.
function storedTask(value: unknown, allowLegacyIdentifiers = false): AsyncTaskEnvelope {
  const schema = allowLegacyIdentifiers ? legacyStoredEnvelopeSchema : strictStoredEnvelopeSchema;
  const envelope = schema.safeParse(value);
  if (!envelope.success)
    throw new PayloadUnverifiableError("Stored task envelope is missing or invalid");
  const source = storedSourceSchema.safeParse(envelope.data.source);
  const metadata = storedMetadataSchema.safeParse(envelope.data);
  if (!source.success || !metadata.success ||
      source.data.eventId !== envelope.data.sourceEventId ||
      source.data.eventType !== envelope.data.taskType)
    throw new PayloadUnverifiableError("Stored task source or metadata is invalid");
  return { ...envelope.data, ...metadata.data, source: source.data };
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
    if (error instanceof PayloadConflictError)
      return quarantine("IDEMPOTENCY_CONFLICT", error);
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

export function createPostgresAsyncTaskStore(
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
  const recoveryQuarantine = table("app_async_recovery_quarantine");
  type RecoveryPosition = { created_at: string; key: string };
  type RecoveryRow = RecoveryPosition & { response_data: unknown };
  type RecoveryScan = { after?: RecoveryPosition; through: RecoveryPosition };
  const recoveryScans = new Map<string, RecoveryScan>();
  const recoveryEligible = `((task.status IN ('pending','failed') AND (task.lease_until IS NULL OR task.lease_until<=now())) OR (task.status='processing' AND (task.lease_until IS NULL OR task.lease_until<=now())))
    AND NOT EXISTS (SELECT 1 FROM ${recoveryQuarantine} AS isolated WHERE isolated.idempotency_key=task.key)
    AND NOT EXISTS (
      SELECT 1 FROM ${table("app_message_quarantine")} AS quarantine
      WHERE quarantine.consumer_group=task.scope AND quarantine.error_code IN ('INVALID_MESSAGE','IDEMPOTENCY_UNVERIFIABLE')
        AND quarantine.topic=task.response_data#>>'{source,offset,topic}'
        AND quarantine.partition::text=task.response_data#>>'{source,offset,partition}'
        AND quarantine.source_offset=task.response_data#>>'{source,offset,offset}'
    )`;
  const leaseMs = options.leaseMs ?? 60000;
  const key = (task: AsyncTaskEnvelope) =>
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
  async function writeTask(client: PoolClient, task: AsyncTaskEnvelope) {
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
  async function requireLease(client: PoolClient, task: LeasedTask) {
    const result = await client.query(
      `SELECT key FROM ${keys} WHERE key=$1 AND status='processing' AND locked_by=$2 AND lease_generation=$3 AND lease_until>now() FOR UPDATE`,
      [key(task), task.lockedBy, task.generation],
    );
    if (result.rows.length !== 1)
      throw new StaleLeaseError("Task lease no longer belongs to this worker");
  }
  async function finish(client: PoolClient, task: LeasedTask) {
    await client.query(
      `UPDATE ${keys} SET status=$2,response_data=$3::jsonb,locked_by=NULL,lease_until=NULL WHERE key=$1`,
      [key(task), task.status, JSON.stringify(task)],
    );
    await writeTask(client, task);
  }
  async function isRecoveryIsolated(client: PoolClient, rowKey: string) {
    const result = await client.query(
      `SELECT 1 FROM ${recoveryQuarantine} WHERE idempotency_key=$1`,
      [rowKey],
    );
    return result.rows.length !== 0;
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- storedTask validates each database JSON value before reconstructing its Kafka message.
  function reconstructRecovery(value: unknown, rowKey: string, group: string) {
    const task = storedTask(value, true);
    const offset = kafkaConsumerOffsetSchema.parse(task.source.offset);
    if (offset.consumerGroup !== group || JSON.stringify([group, task.idempotencyKey]) !== rowKey)
      throw new PayloadUnverifiableError("Stored task belongs to another recovery identity");
    return {
      nextRetryAt: task.nextRetryAt,
      message: {
        topic: offset.topic,
        partition: offset.partition,
        offset: offset.offset,
        value: JSON.stringify({
          eventId: task.sourceEventId,
          eventType: task.taskType,
          traceId: task.traceId,
          taskId: task.taskId,
          idempotencyKey: task.idempotencyKey,
          payload: task.payload,
        }),
      },
    };
  }
  async function isolateInvalidRecovery(rowKey: string, group: string) {
    return transaction(async (client) => {
      const locked = await client.query<{ response_data: unknown }>(
        `SELECT response_data FROM ${keys} WHERE key=$1 FOR UPDATE`, [rowKey],
      );
      if (locked.rows.length === 0) return;
      const eligible = await client.query(
        `SELECT 1 FROM ${keys} AS task WHERE task.key=$1 AND task.scope=$2 AND ${recoveryEligible}`,
        [rowKey, group],
      );
      if (eligible.rows.length === 0) return;
      try {
        return reconstructRecovery(locked.rows[0].response_data, rowKey, group);
      } catch (error) {
        if (!(error instanceof PayloadUnverifiableError)) throw error;
        await client.query(
          `INSERT INTO ${recoveryQuarantine}(idempotency_key,consumer_group,original_record,error_code,error_message)
          SELECT task.key,task.scope,to_jsonb(task),'INVALID_RECOVERY_RECORD',$2 FROM ${keys} AS task WHERE task.key=$1
          ON CONFLICT(idempotency_key) DO NOTHING`,
          [rowKey, error.message],
        );
      }
    });
  }
  const store: AsyncConsumerStore & {
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
        if (!row) throw new Error("Claimed idempotency row is missing");
        if (await isRecoveryIsolated(client, row.key))
          throw new PayloadUnverifiableError("Stored task is isolated from recovery");
        const terminal = ["succeeded", "dead_letter", "canceled"].includes(row.status);
        const parsedHash = z.string().safeParse(row.request_hash);
        if (!parsedHash.success)
          throw new PayloadUnverifiableError("Stored payload hash is invalid");
        const persistedHash = parsedHash.data;
        const legacy = /^[a-f0-9]{64}$/.test(persistedHash);
        if (!legacy && !/^v2:[a-f0-9]{64}$/.test(persistedHash))
          throw new PayloadUnverifiableError("Stored payload hash version is unsupported");
        if (!legacy && persistedHash !== hash)
          throw new PayloadConflictError("Idempotency key is already bound to another payload");
        if (terminal && row.response_data === null) {
          if (legacy && legacyPayloadHash(incoming) !== persistedHash)
            throw new PayloadUnverifiableError("Compacted legacy task cannot prove payload identity");
          return { kind: "terminal", task: incoming };
        }
        const stored = storedTask(row.response_data);
        if (payloadHash(stored) !== hash)
          throw new PayloadConflictError("Idempotency key is already bound to another payload");
        if (key(stored) !== key(incoming))
          throw new PayloadUnverifiableError("Stored task belongs to another idempotency key");
        if (terminal) return { kind: "terminal", task: incoming };
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
        const task: LeasedTask = {
          ...stored,
          status: "running",
          lockedBy: workerId,
          generation,
          requestHash: persistedHash,
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
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("Recovery message limit must be a positive safe integer");
      let scan = recoveryScans.get(group);
      if (!scan) {
        const upper = await pool.query<RecoveryPosition>(
          `SELECT created_at::text,key FROM ${keys} WHERE scope=$1 ORDER BY created_at DESC,key DESC LIMIT 1`,
          [group],
        );
        if (!upper.rows[0]) return [];
        scan = { through: upper.rows[0] };
      }
      const budget = Math.max(100, limit);
      const result = await pool.query<RecoveryRow>(
        `SELECT task.created_at::text,task.key,task.response_data FROM ${keys} AS task
        WHERE task.scope=$1 AND ${recoveryEligible}
          AND ($2::timestamptz IS NULL OR (task.created_at,task.key)>($2::timestamptz,$3::text))
          AND (task.created_at,task.key)<=($4::timestamptz,$5::text)
        ORDER BY task.created_at,task.key LIMIT $6`,
        [group, scan.after?.created_at, scan.after?.key, scan.through.created_at, scan.through.key, budget],
      );
      let after = scan.after;
      let beforeFirstReturnedMessage: RecoveryPosition | undefined;
      const messages: ConsumerMessage[] = [];
      for (const row of result.rows) {
        let recovered;
        try {
          recovered = reconstructRecovery(row.response_data, row.key, group);
        } catch (error) {
          if (!(error instanceof PayloadUnverifiableError)) throw error;
          recovered = await isolateInvalidRecovery(row.key, group);
        }
        if (recovered && (!recovered.nextRetryAt || Date.parse(recovered.nextRetryAt) <= Date.now())) {
          if (messages.length === 0) beforeFirstReturnedMessage = after;
          messages.push(recovered.message);
        }
        after = { created_at: row.created_at, key: row.key };
        if (messages.length === limit) break;
      }
      if (messages.length > 0) recoveryScans.set(group, { ...scan, after: beforeFirstReturnedMessage });
      else if (result.rows.length < budget) recoveryScans.delete(group);
      else recoveryScans.set(group, { ...scan, after });
      return messages;
    },
    async replay(group, idempotencyKey) {
      return transaction(async (client) => {
        const {
          rows: [row],
        } = await client.query(
          `SELECT * FROM ${keys} WHERE key=$1 AND status IN ('failed','dead_letter') FOR UPDATE`,
          [JSON.stringify([group, idempotencyKey])],
        );
        if (!row || await isRecoveryIsolated(client, row.key)) return false;
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
  recovery?: RecoveryGuard;
  clientId?: string;
  brokers?: string[];
  maxMessages?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  eachMessage: (message: ConsumerMessage) => Promise<AsyncConsumerResult>;
}) {
  const groupId = asyncConsumerGroupSchema.parse(options.groupId);
  const brokers =
    options.brokers ??
    (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);
  if (!brokers.length)
    throw new Error("KAFKA_BROKERS is required for Kafka consumers");
  const consumer = new Kafka({
    ...readKafkaConfig({ ...process.env, KAFKA_BROKERS: brokers.join(",") }),
    clientId: options.clientId ?? "pstack-worker",
    brokers,
    logLevel: logLevel.NOTHING,
  }).consumer({ groupId: options.recovery?.transportGroup ?? groupId });
  let processed = 0;
  let completed!: () => void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Promise rejection callback; failure values propagate without reinterpretation.
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
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  try {
    if (options.signal?.aborted) return { processed };
    await consumer.connect();
    if (options.recovery) {
      await options.recovery.check();
      let checking = false;
      recoveryTimer = setInterval(() => {
        if (checking) return;
        checking = true;
        void options.recovery?.check().catch(failed).finally(() => { checking = false; });
      }, 1000);
    }
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
          try { await options.recovery?.beforeMessage(message); }
          catch (error) { failed(error); throw error; }
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
              try { await options.recovery?.check(); }
              catch (error) { failed(error); throw error; }
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
    if (recoveryTimer) clearInterval(recoveryTimer);
    options.signal?.removeEventListener("abort", abort);
    removeCrash();
    try {
      await consumer.stop();
    } finally {
      await consumer.disconnect();
    }
  }
}
