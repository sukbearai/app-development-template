import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "@pstack/database/client";
import {
  asyncIdentifierSchema,
  asyncTaskStatusSchema,
  kafkaConsumerOffsetSchema,
  type AsyncTaskEnvelope,
} from "@pstack/contracts/async-contracts";
import {
  payloadHash,
  legacyPayloadHash,
  PayloadConflictError,
  PayloadUnverifiableError,
  StaleLeaseError,
  type AsyncConsumerStore,
  type ConsumerMessage,
  type LeasedTask,
} from "./async-task";

export function quoteIdent(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

const storedDateSchema = z.string().refine((date) => Number.isFinite(Date.parse(date)));

const storedIdentifierSchema = z
  .string()
  .refine((value) => asyncIdentifierSchema.safeParse(value).success);

const legacyStoredIdentifierSchema = z.string().refine((value) => value.trim() !== "");

const storedSourceSchema = z.looseObject({
  offset: kafkaConsumerOffsetSchema.loose(),
  eventId: z.string(),
  eventType: z.string(),
  occurredAt: storedDateSchema.optional(),
});

function storedEnvelopeSchema(allowLegacyIdentifiers: boolean) {
  const identifier = allowLegacyIdentifiers ? legacyStoredIdentifierSchema : storedIdentifierSchema;
  return z
    .looseObject({
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
    })
    .refine((record) => Object.hasOwn(record, "payload"));
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
  if (
    !source.success ||
    !metadata.success ||
    source.data.eventId !== envelope.data.sourceEventId ||
    source.data.eventType !== envelope.data.taskType
  )
    throw new PayloadUnverifiableError("Stored task source or metadata is invalid");
  return { ...envelope.data, ...metadata.data, source: source.data };
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
  if (!options.pool && options.databaseUrl && options.databaseUrl !== process.env.DATABASE_URL)
    throw new Error("Inject a pool for a database other than DATABASE_URL");
  const pool = options.pool ?? getPool();
  const table = (name: string) =>
    options.schemaName ? `${quoteIdent(options.schemaName)}.${quoteIdent(name)}` : quoteIdent(name);
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
  async function transaction<R>(body: (client: PoolClient) => Promise<R>): Promise<R> {
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
        `SELECT response_data FROM ${keys} WHERE key=$1 FOR UPDATE`,
        [rowKey],
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
            throw new PayloadUnverifiableError(
              "Compacted legacy task cannot prove payload identity",
            );
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
          (error instanceof Error ? error.message : String(error)).replaceAll("\u0000", "\\u0000"),
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
        [
          group,
          scan.after?.created_at,
          scan.after?.key,
          scan.through.created_at,
          scan.through.key,
          budget,
        ],
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
        if (
          recovered &&
          (!recovered.nextRetryAt || Date.parse(recovered.nextRetryAt) <= Date.now())
        ) {
          if (messages.length === 0) beforeFirstReturnedMessage = after;
          messages.push(recovered.message);
        }
        after = { created_at: row.created_at, key: row.key };
        if (messages.length === limit) break;
      }
      if (messages.length > 0)
        recoveryScans.set(group, { ...scan, after: beforeFirstReturnedMessage });
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
        if (!row || (await isRecoveryIsolated(client, row.key))) return false;
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
