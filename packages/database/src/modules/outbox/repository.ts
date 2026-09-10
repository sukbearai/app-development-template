import { type OutboxEvent, outboxEventSchema } from "@pstack/contracts/modules/outbox/contracts";

import { type TransactionContext, getDatabase, type DatabaseContext } from "../../client";

import { appOutboxEvents } from "../../schema";

import { desc } from "drizzle-orm";

import { jsonObject, iso } from "../../row-values.ts";

export async function insertOutboxEvent(event: OutboxEvent, context: TransactionContext) {
  await context.insert(appOutboxEvents).values({
    id: event.id,
    topic: event.topic,
    eventType: event.eventType,
    payload: event.payload,
    status: event.status,
    attempts: event.attempts,
    maxAttempts: event.maxAttempts,
    nextAttemptAt: new Date(event.nextAttemptAt),
    lockedBy: event.lockedBy,
    lockedAt: event.lockedAt ? new Date(event.lockedAt) : undefined,
    publishedAt: event.publishedAt ? new Date(event.publishedAt) : undefined,
    errorCode: event.errorCode,
    lastError: event.lastError,
    traceId: event.traceId,
    createdAt: new Date(event.createdAt),
    updatedAt: new Date(event.updatedAt),
  });
}

export async function getOutboxEvents(context: DatabaseContext = getDatabase()) {
  const rows = await context
    .select()
    .from(appOutboxEvents)
    .orderBy(desc(appOutboxEvents.createdAt))
    .limit(100);
  return rows.map((row): OutboxEvent => ({
    id: row.id,
    topic: row.topic,
    eventType: row.eventType,
    payload: jsonObject(row.payload),
    status: outboxEventSchema.shape.status.parse(row.status),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    lockedBy: row.lockedBy || undefined,
    lockedAt: row.lockedAt ? iso(row.lockedAt) : undefined,
    publishedAt: row.publishedAt ? iso(row.publishedAt) : undefined,
    errorCode: row.errorCode || undefined,
    lastError: row.lastError || undefined,
    traceId: row.traceId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}
