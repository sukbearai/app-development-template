import type { TelemetryEvent } from "@pstack/contracts/modules/telemetry/contracts";

import { type TransactionContext, getDatabase, type DatabaseContext } from "../../client";

import { appTelemetryEvents } from "../../schema";

import { desc } from "drizzle-orm";

import { jsonObject, iso } from "../../row-values.ts";

export async function insertTelemetryEvent(event: TelemetryEvent, context: TransactionContext) {
  await context.insert(appTelemetryEvents).values({
    id: event.id,
    event: event.event,
    route: event.route,
    traceId: event.traceId,
    payload: event.payload || {},
    occurredAt: new Date(event.occurredAt),
  });
}

export async function getTelemetryEvents(context: DatabaseContext = getDatabase()) {
  const rows = await context
    .select()
    .from(appTelemetryEvents)
    .orderBy(desc(appTelemetryEvents.occurredAt))
    .limit(100);
  return rows.map((row): TelemetryEvent => ({
    id: row.id,
    event: row.event,
    route: row.route || undefined,
    traceId: row.traceId,
    payload: jsonObject(row.payload),
    occurredAt: iso(row.occurredAt),
  }));
}
