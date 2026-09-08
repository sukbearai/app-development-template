import { z } from "zod";
import { Kafka, Partitioners, type Producer } from "kafkajs";
import { type Pool, type PoolClient } from "pg";
import { getPool } from "@pstack/database/client";
import { loadWorkerEnv } from "./env";
import { readKafkaConfig } from "@pstack/kafka";
import { assertKafkaPublishingReady } from "./kafka-recovery";

export type OutboxEvent = {
  id: string;
  topic: string;
  eventType: string;
  traceId: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  leaseGeneration?: number;
};

export type OutboxWorkerOptions = {
  batchSize?: number;
  databaseUrl?: string;
  workerId?: string;
  dryRun?: boolean;
  retryBaseMs?: number;
  retryMaxMs?: number;
  producer?: Producer;
  pool?: Pool;
  leaseMs?: number;
  signal?: AbortSignal;
};

export type OutboxWorkerResult = {
  inspected: number;
  staleOwner: number;
  claimed: number;
  published: number;
  failed: number;
  deadLetter: number;
};

export function retryDelayMs(attempt: number, baseMs = 1000, maxMs = 300000) {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(baseMs * 2 ** (boundedAttempt - 1), maxMs);
}

const outboxRowSchema = z.object({
  id: z.string(), topic: z.string(), event_type: z.string(), trace_id: z.string(),
  payload: z.unknown(), attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(), lease_generation: z.number().int().positive(),
});
type OutboxRow = z.infer<typeof outboxRowSchema>;
function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    eventType: row.event_type,
    traceId: row.trace_id,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseGeneration: row.lease_generation,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Publishing failures can throw arbitrary values; diagnostics only serialize their message.
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const nestedOutboxPayloadSchema = z.looseObject({
  eventId: z.string(),
  eventType: z.string(),
  traceId: z.unknown().optional(),
  occurredAt: z.unknown().optional(),
  payload: z.unknown(),
});
function asyncTaskPayload(event: OutboxEvent) {
  const parsed = nestedOutboxPayloadSchema.safeParse(event.payload);
  if (!parsed.success || !Object.hasOwn(parsed.data, "payload")) return undefined;
  const payload = parsed.data;
  if (payload.eventId !== event.id) return undefined;
  if (payload.eventType !== event.eventType) return undefined;
  if (payload.traceId && payload.traceId !== event.traceId) return payload;
  if (!payload.traceId && event.traceId) return undefined;
  return payload;
}

export function outboxKafkaMessageValue(
  event: OutboxEvent,
  occurredAt = new Date().toISOString(),
) {
  const asyncPayload = asyncTaskPayload(event);
  if (asyncPayload) {
    return JSON.stringify({
      ...asyncPayload,
      eventId: asyncPayload.eventId || event.id,
      eventType: asyncPayload.eventType || event.eventType,
      traceId: asyncPayload.traceId || event.traceId,
      payload: asyncPayload.payload,
      occurredAt: asyncPayload.occurredAt || occurredAt,
    });
  }
  return JSON.stringify({
    eventId: event.id,
    eventType: event.eventType,
    traceId: event.traceId,
    payload: event.payload,
    attempts: event.attempts,
    occurredAt,
  });
}

export function outboxKafkaMessageKey(event: OutboxEvent) {
  return event.traceId || event.id;
}

export async function createProducer() {
  const env = loadWorkerEnv();
  if (!env.kafkaBrokers.length)
    throw new Error("KAFKA_BROKERS is required unless OUTBOX_DRY_RUN=1");
  const kafka = new Kafka({
    ...readKafkaConfig(),
    clientId: env.kafkaClientId,
    brokers: env.kafkaBrokers,
  });
  const producer = kafka.producer({
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  await producer.connect();
  return producer;
}

export async function claimEvents(
  client: PoolClient,
  options: { batchSize: number; workerId: string; leaseMs?: number },
) {
  const result = await client.query(
    `
    WITH next_events AS (
      SELECT id FROM app_outbox_events
      WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
         OR (status = 'processing' AND COALESCE(lease_until, locked_at, '-infinity'::timestamptz) <= now())
      ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE app_outbox_events AS event
    SET status = 'processing', locked_by = $2, locked_at = now(),
        lease_until = now() + $3 * interval '1 millisecond',
        lease_generation = lease_generation + 1, updated_at = now()
    WHERE event.id IN (SELECT id FROM next_events)
    RETURNING event.*
  `,
    [options.batchSize, options.workerId, options.leaseMs ?? 60000],
  );
  return result.rows.map((row) => toOutboxEvent(outboxRowSchema.parse(row)));
}

export async function markPublished(
  pool: Pick<Pool, "query">,
  event: OutboxEvent,
  workerId: string,
) {
  const result = await pool.query(
    `UPDATE app_outbox_events
    SET status = 'published', attempts = attempts + 1, published_at = now(),
        locked_by = NULL, locked_at = NULL, lease_until = NULL,
        error_code = NULL, last_error = NULL, updated_at = now()
    WHERE id = $1 AND status = 'processing' AND locked_by = $2
      AND lease_generation = $3 AND lease_until > now() RETURNING id`,
    [event.id, workerId, event.leaseGeneration],
  );
  return result.rows.length === 1;
}

async function markFailed(
  pool: Pool,
  event: OutboxEvent,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This failure transition accepts an arbitrary publisher rejection for diagnostic persistence.
  error: unknown,
  options: {
    workerId: string;
    retryBaseMs: number;
    retryMaxMs: number;
  },
) {
  const attempts = event.attempts + 1;
  const dead = attempts >= event.maxAttempts;
  const result = await pool.query(
    `UPDATE app_outbox_events
    SET status = $4, attempts = $5, next_attempt_at = now() + $6 * interval '1 millisecond',
        locked_by = NULL, locked_at = NULL, lease_until = NULL, error_code = $7, last_error = $8, updated_at = now()
    WHERE id = $1 AND status = 'processing' AND locked_by = $2
      AND lease_generation = $3 AND lease_until > now() RETURNING id`,
    [
      event.id,
      options.workerId,
      event.leaseGeneration,
      dead ? "dead_letter" : "failed",
      attempts,
      retryDelayMs(attempts, options.retryBaseMs, options.retryMaxMs),
      dead ? "OUTBOX_DEAD_LETTER" : "OUTBOX_RETRY_PENDING",
      errorMessage(error),
    ],
  );
  return result.rows.length === 0 ? "stale" : dead ? "dead" : "failed";
}

export async function processOutboxOnce(
  options: OutboxWorkerOptions = {},
): Promise<OutboxWorkerResult> {
  const env = loadWorkerEnv({ allowMissingPublisher: options.dryRun === true });
  const resolved = {
    batchSize: options.batchSize ?? env.outboxBatchSize,
    workerId:
      options.workerId ?? process.env.WORKER_ID ?? `worker-${process.pid}`,
    dryRun: options.dryRun ?? env.outboxPublisher === "dry-run",
    retryBaseMs: options.retryBaseMs ?? env.outboxRetryBaseMs,
    retryMaxMs: options.retryMaxMs ?? env.outboxRetryMaxMs,
    leaseMs: options.leaseMs ?? 60000,
  };
  if (
    !options.pool &&
    options.databaseUrl &&
    options.databaseUrl !== env.databaseUrl
  ) {
    throw new Error("Inject a pool for a database other than DATABASE_URL");
  }
  const pool = options.pool ?? getPool();
  const result = {
    inspected: 0,
    staleOwner: 0,
    claimed: 0,
    published: 0,
    failed: 0,
    deadLetter: 0,
  };
  if (options.signal?.aborted) return result;
  if (resolved.dryRun) {
    const preview = await pool.query(
      `SELECT id FROM app_outbox_events
      WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
         OR (status = 'processing' AND COALESCE(lease_until, locked_at, '-infinity'::timestamptz) <= now())
      ORDER BY created_at LIMIT $1`,
      [resolved.batchSize],
    );
    result.inspected = preview.rows.length;
    return result;
  }
  await assertKafkaPublishingReady(pool);
  const producer = options.producer ?? (await createProducer());
  try {
    // Claim one event at a time so queued sends cannot outlive a batch lease.
    for (let i = 0; i < resolved.batchSize && !options.signal?.aborted; i++) {
      if (i > 0) await assertKafkaPublishingReady(pool);
      const client = await pool.connect();
      let event: OutboxEvent | undefined;
      try {
        [event] = await claimEvents(client, { ...resolved, batchSize: 1 });
      } finally {
        client.release();
      }
      if (!event) break;
      result.claimed++;
      try {
        await producer.send({
          topic: event.topic,
          messages: [
            {
              key: outboxKafkaMessageKey(event),
              value: outboxKafkaMessageValue(event),
            },
          ],
        });
      } catch (error) {
        const state = await markFailed(pool, event, error, resolved);
        if (state === "stale") result.staleOwner++;
        else if (state === "dead") result.deadLetter++;
        else result.failed++;
        continue;
      }
      // A database acknowledgement failure leaves processing for lease recovery.
      // Kafka may already have accepted the event, so delivery is at least once.
      if (await markPublished(pool, event, resolved.workerId))
        result.published++;
      else result.staleOwner++;
    }
    return result;
  } finally {
    if (!options.producer) await producer.disconnect();
  }
}
