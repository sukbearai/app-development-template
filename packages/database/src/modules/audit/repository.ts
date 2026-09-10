import type {
  AuditEvent,
  AuditPage,
  AuditPageQuery,
} from "@pstack/contracts/modules/audit/contracts";

import { type TransactionContext, getDatabase, type DatabaseContext } from "../../client";

import { appAuditLogs } from "../../schema";

import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";

import { jsonRecordSchema } from "@pstack/contracts/primitives";

import { containsText } from "../../row-values.ts";

export async function insertAuditEvent(event: AuditEvent, context: TransactionContext) {
  await context.insert(appAuditLogs).values({
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    traceId: event.traceId,
    metadata: event.metadata || {},
    createdAt: new Date(event.createdAt),
  });
}

export async function getAuditPage(
  query: AuditPageQuery,
  database: DatabaseContext = getDatabase(),
): Promise<AuditPage> {
  const search = containsText(query.search);
  const where = and(
    query.search
      ? or(
          ilike(appAuditLogs.traceId, search),
          ilike(appAuditLogs.actorId, search),
          ilike(appAuditLogs.targetId, search),
        )
      : undefined,
    query.action ? eq(appAuditLogs.action, query.action) : undefined,
  );
  const order = query.direction === "asc" ? asc : desc;
  const [rows, totals] = await Promise.all([
    database
      .select()
      .from(appAuditLogs)
      .where(where)
      .orderBy(order(appAuditLogs[query.sort]), order(appAuditLogs.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    database.select({ total: count() }).from(appAuditLogs).where(where),
  ]);
  return {
    page: query.page,
    limit: query.limit,
    total: totals[0].total,
    items: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actorId ?? undefined,
      targetType: row.targetType ?? undefined,
      targetId: row.targetId ?? undefined,
      traceId: row.traceId,
      metadata: jsonRecordSchema.parse(row.metadata),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
