import { and, asc, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { jsonRecordSchema } from "@pstack/contracts";
import type {
  AuditPage,
  AuditPageQuery,
  UserPage,
  UserPageQuery,
} from "@pstack/contracts/admin-pages";
import { getDatabase, type DatabaseContext } from "./client";
import { appAuditLogs, appUserRoles, appUsers } from "./schema";

function containsText(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function getUserPage(
  query: UserPageQuery,
  database: DatabaseContext = getDatabase(),
): Promise<UserPage> {
  const search = containsText(query.search);
  const where = and(
    query.search
      ? or(ilike(appUsers.account, search), ilike(appUsers.displayName, search))
      : undefined,
    query.status === "all" ? undefined : eq(appUsers.status, query.status),
  );
  const order = query.direction === "asc" ? asc : desc;
  const [rows, totals] = await Promise.all([
    database
      .select()
      .from(appUsers)
      .where(where)
      .orderBy(order(appUsers[query.sort]), order(appUsers.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    database.select({ total: count() }).from(appUsers).where(where),
  ]);
  const roleRows = rows.length
    ? await database
        .select()
        .from(appUserRoles)
        .where(
          inArray(
            appUserRoles.userId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows)
    rolesByUser.set(row.userId, [...(rolesByUser.get(row.userId) ?? []), row.roleId]);
  return {
    page: query.page,
    limit: query.limit,
    total: totals[0].total,
    items: rows.map((row) => ({
      id: row.id,
      account: row.account,
      displayName: row.displayName,
      status: row.status,
      roleIds: rolesByUser.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    })),
  };
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
