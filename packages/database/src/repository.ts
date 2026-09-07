import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import type {
  AuditEvent,
  AuthSession,
  FileAsset,
  OutboxEvent,
  Permission,
  Role,
  TelemetryEvent,
  User,
} from "@pstack/contracts";
import {
  getDatabase,
  type DatabaseContext,
  type TransactionContext,
} from "./client";
import {
  appUploadIntents,
  appAuditLogs,
  appFileAssets,
  appOutboxEvents,
  appPermissions,
  appRolePermissions,
  appRoles,
  appTasks,
  appTelemetryEvents,
  appUserRoles,
  appUsers,
  appUserSessions,
} from "./schema";
function iso(value: Date | string) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapUser(
  row: typeof appUsers.$inferSelect,
  roleIds: string[] = [],
): User {
  return {
    id: row.id,
    account: row.account,
    displayName: row.displayName,
    status: row.status,
    roleIds,
    createdAt: iso(row.createdAt),
  };
}

function mapRole(
  row: typeof appRoles.$inferSelect,
  permissionIds: string[] = [],
): Role {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    permissionIds,
  };
}

function mapSession(
  row: typeof appUserSessions.$inferSelect,
): AuthSession & { secretHash: string; revokedAt?: string } {
  return {
    id: row.id,
    userId: row.userId,
    secretHash: row.secretHash,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : undefined,
  };
}

export async function getUsers(context: DatabaseContext = getDatabase()) {
  const database = context;
  const [userRows, userRoleRows] = await Promise.all([
    database.select().from(appUsers).orderBy(asc(appUsers.createdAt)),
    database.select().from(appUserRoles),
  ]);
  const roleIdsByUser = new Map<string, string[]>();
  for (const row of userRoleRows) {
    roleIdsByUser.set(row.userId, [
      ...(roleIdsByUser.get(row.userId) || []),
      row.roleId,
    ]);
  }
  return userRows.map((row) => mapUser(row, roleIdsByUser.get(row.id) || []));
}

export async function getUserByAccount(
  account: string,
  context: DatabaseContext = getDatabase(),
) {
  const database = context;
  const row = (
    await database
      .select()
      .from(appUsers)
      .where(eq(appUsers.account, account))
      .limit(1)
  )[0];
  if (!row) return undefined;
  const roleRows = await database
    .select()
    .from(appUserRoles)
    .where(eq(appUserRoles.userId, row.id));
  return {
    user: mapUser(
      row,
      roleRows.map((role) => role.roleId),
    ),
    passwordHash: row.passwordHash,
  };
}

export async function getUserById(
  userId: string,
  context: DatabaseContext = getDatabase(),
) {
  const database = context;
  const row = (
    await database
      .select()
      .from(appUsers)
      .where(eq(appUsers.id, userId))
      .limit(1)
  )[0];
  if (!row) return undefined;
  const roleRows = await database
    .select()
    .from(appUserRoles)
    .where(eq(appUserRoles.userId, row.id));
  return mapUser(
    row,
    roleRows.map((role) => role.roleId),
  );
}

export async function getRoles(context: DatabaseContext = getDatabase()) {
  const database = context;
  const [roleRows, rolePermissionRows] = await Promise.all([
    database.select().from(appRoles).orderBy(asc(appRoles.createdAt)),
    database.select().from(appRolePermissions),
  ]);
  const permissionIdsByRole = new Map<string, string[]>();
  for (const row of rolePermissionRows) {
    permissionIdsByRole.set(row.roleId, [
      ...(permissionIdsByRole.get(row.roleId) || []),
      row.permissionId,
    ]);
  }
  return roleRows.map((row) =>
    mapRole(row, permissionIdsByRole.get(row.id) || []),
  );
}

export async function getPermissions(context: DatabaseContext = getDatabase()) {
  const database = context;
  const rows = await database
    .select()
    .from(appPermissions)
    .orderBy(asc(appPermissions.id));
  return rows.map((row): Permission => ({ id: row.id, name: row.name }));
}

export async function createUser(
  input: User & { passwordHash: string },
  context: TransactionContext,
) {
  const database = context;
  {
    const tx = context;
    await tx.insert(appUsers).values({
      id: input.id,
      account: input.account,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      status: input.status,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(),
    });
    if (input.roleIds.length) {
      await tx
        .insert(appUserRoles)
        .values(input.roleIds.map((roleId) => ({ userId: input.id, roleId })))
        .onConflictDoNothing();
    }
  }
}

export async function updateUser(
  input: {
    id: string;
    displayName?: string;
    status?: User["status"];
    roleIds?: string[];
  },
  context: TransactionContext,
) {
  const database = context;
  {
    const tx = context;
    const changes: Partial<typeof appUsers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.displayName !== undefined)
      changes.displayName = input.displayName;
    if (input.status !== undefined) changes.status = input.status;
    await tx.update(appUsers).set(changes).where(eq(appUsers.id, input.id));
    if (input.roleIds) {
      await tx.delete(appUserRoles).where(eq(appUserRoles.userId, input.id));
      if (input.roleIds.length) {
        await tx
          .insert(appUserRoles)
          .values(input.roleIds.map((roleId) => ({ userId: input.id, roleId })))
          .onConflictDoNothing();
      }
    }
  }
}

export async function createRole(input: Role, context: TransactionContext) {
  const database = context;
  {
    const tx = context;
    await tx
      .insert(appRoles)
      .values({ id: input.id, name: input.name, status: input.status });
    if (input.permissionIds.length) {
      await tx
        .insert(appRolePermissions)
        .values(
          input.permissionIds.map((permissionId) => ({
            roleId: input.id,
            permissionId,
          })),
        )
        .onConflictDoNothing();
    }
  }
}

export async function updateRole(
  input: {
    id: string;
    name?: string;
    status?: Role["status"];
    permissionIds?: string[];
  },
  context: TransactionContext,
) {
  const database = context;
  {
    const tx = context;
    const changes: Partial<typeof appRoles.$inferInsert> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.status !== undefined) changes.status = input.status;
    if (Object.keys(changes).length) {
      await tx.update(appRoles).set(changes).where(eq(appRoles.id, input.id));
    }
    if (input.permissionIds) {
      await tx
        .delete(appRolePermissions)
        .where(eq(appRolePermissions.roleId, input.id));
      if (input.permissionIds.length) {
        await tx
          .insert(appRolePermissions)
          .values(
            input.permissionIds.map((permissionId) => ({
              roleId: input.id,
              permissionId,
            })),
          )
          .onConflictDoNothing();
      }
    }
  }
}

export async function saveSession(
  input: AuthSession & { secretHash: string },
  context: TransactionContext,
) {
  await context.insert(appUserSessions).values({
    id: input.id,
    userId: input.userId,
    secretHash: input.secretHash,
    expiresAt: new Date(input.expiresAt),
    createdAt: new Date(input.createdAt),
    lastUsedAt: new Date(input.lastUsedAt),
  });
}

export async function getSession(
  sessionId: string,
  context: DatabaseContext = getDatabase(),
) {
  const row = (
    await context
      .select()
      .from(appUserSessions)
      .where(eq(appUserSessions.id, sessionId))
      .limit(1)
  )[0];
  return row ? mapSession(row) : undefined;
}

export async function touchSession(
  sessionId: string,
  context: TransactionContext,
) {
  await context
    .update(appUserSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(appUserSessions.id, sessionId));
}

export async function revokeSession(
  sessionId: string,
  context: TransactionContext,
) {
  await context
    .update(appUserSessions)
    .set({ revokedAt: new Date() })
    .where(eq(appUserSessions.id, sessionId));
}

export async function insertAuditEvent(
  event: AuditEvent,
  context: TransactionContext,
) {
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

export async function getAuditEvents(context: DatabaseContext = getDatabase()) {
  const rows = await context
    .select()
    .from(appAuditLogs)
    .orderBy(desc(appAuditLogs.createdAt))
    .limit(100);
  return rows.map(
    (row): AuditEvent => ({
      id: row.id,
      actorId: row.actorId || undefined,
      action: row.action,
      targetType: row.targetType || undefined,
      targetId: row.targetId || undefined,
      traceId: row.traceId,
      metadata: jsonObject(row.metadata),
      createdAt: iso(row.createdAt),
    }),
  );
}

export async function insertTelemetryEvent(
  event: TelemetryEvent,
  context: TransactionContext,
) {
  await context.insert(appTelemetryEvents).values({
    id: event.id,
    event: event.event,
    route: event.route,
    traceId: event.traceId,
    payload: event.payload || {},
    occurredAt: new Date(event.occurredAt),
  });
}

export async function getTelemetryEvents(
  context: DatabaseContext = getDatabase(),
) {
  const rows = await context
    .select()
    .from(appTelemetryEvents)
    .orderBy(desc(appTelemetryEvents.occurredAt))
    .limit(100);
  return rows.map(
    (row): TelemetryEvent => ({
      id: row.id,
      event: row.event,
      route: row.route || undefined,
      traceId: row.traceId,
      payload: jsonObject(row.payload),
      occurredAt: iso(row.occurredAt),
    }),
  );
}

export async function insertFileAsset(
  file: FileAsset,
  context: TransactionContext,
) {
  await context.insert(appFileAssets).values({
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    storageKey: file.storageKey,
    uploadedBy: file.uploadedBy,
    uploadedAt: new Date(file.uploadedAt),
  });
}

export async function getFileAssets(context: DatabaseContext = getDatabase()) {
  const rows = await context
    .select()
    .from(appFileAssets)
    .orderBy(desc(appFileAssets.uploadedAt))
    .limit(100);
  return rows.map(
    (row): FileAsset => ({
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      storageKey: row.storageKey,
      uploadedBy: row.uploadedBy || undefined,
      uploadedAt: iso(row.uploadedAt),
    }),
  );
}

export async function insertOutboxEvent(
  event: OutboxEvent,
  context: TransactionContext,
) {
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

export async function getOutboxEvents(
  context: DatabaseContext = getDatabase(),
) {
  const rows = await context
    .select()
    .from(appOutboxEvents)
    .orderBy(desc(appOutboxEvents.createdAt))
    .limit(100);
  return rows.map(
    (row): OutboxEvent => ({
      id: row.id,
      topic: row.topic,
      eventType: row.eventType,
      payload: jsonObject(row.payload),
      status: row.status as OutboxEvent["status"],
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
    }),
  );
}

export async function getAdminCounts(context: DatabaseContext = getDatabase()) {
  const result = await context.execute<{
    users: string;
    audit_events: string;
    telemetry_events: string;
    files: string;
    outbox_pending: string;
  }>(sql`
    select
      (select count(*) from app_users) as users,
      (select count(*) from app_audit_logs) as audit_events,
      (select count(*) from app_telemetry_events) as telemetry_events,
      (select count(*) from app_file_assets) as files,
      (select count(*) from app_outbox_events where status = 'pending') as outbox_pending
  `);
  const row = result.rows[0];
  return {
    users: Number(row.users),
    auditEvents: Number(row.audit_events),
    telemetryEvents: Number(row.telemetry_events),
    files: Number(row.files),
    outboxPending: Number(row.outbox_pending),
  };
}

export async function getAsyncRuntimeHealthRows(
  context: DatabaseContext = getDatabase(),
) {
  const database = context;
  const [outboxEvents, tasks] = await Promise.all([
    database
      .select({
        id: appOutboxEvents.id,
        topic: appOutboxEvents.topic,
        status: appOutboxEvents.status,
        createdAt: appOutboxEvents.createdAt,
        lockedAt: appOutboxEvents.lockedAt,
      })
      .from(appOutboxEvents),
    database
      .select({
        id: appTasks.id,
        status: appTasks.status,
      })
      .from(appTasks),
  ]);
  return { outboxEvents, tasks };
}

export async function lockIdentity(context: TransactionContext) {
  await context.execute(sql`select pg_advisory_xact_lock(741829310)`);
}
export async function revokeUserSessions(
  userId: string,
  context: TransactionContext,
) {
  await context
    .update(appUserSessions)
    .set({ revokedAt: new Date() })
    .where(eq(appUserSessions.userId, userId));
}
export async function databaseProbe() {
  await getDatabase().execute(sql`select 1`);
}

export async function insertUploadIntent(
  input: typeof appUploadIntents.$inferInsert,
  tx: TransactionContext,
) {
  await tx.insert(appUploadIntents).values(input);
}
export async function lockUploadIntent(id: string, tx: TransactionContext) {
  return (
    await tx
      .select()
      .from(appUploadIntents)
      .where(eq(appUploadIntents.id, id))
      .for("update")
  )[0];
}
export async function setUploadIntentState(
  id: string,
  state: (typeof appUploadIntents.$inferSelect)["state"],
  tx: TransactionContext,
) {
  await tx
    .update(appUploadIntents)
    .set({ state, updatedAt: new Date() })
    .where(eq(appUploadIntents.id, id));
}
export async function getStaleUploadIntents(before: Date) {
  return getDatabase()
    .select()
    .from(appUploadIntents)
    .where(
      and(
        lte(appUploadIntents.updatedAt, before),
        sql`${appUploadIntents.state} in ('pending','cleanup','deleted')`,
      ),
    )
    .orderBy(asc(appUploadIntents.updatedAt))
    .limit(100);
}
export async function storageKeyReferenced(
  storageKey: string,
  tx: TransactionContext,
) {
  return (
    (
      await tx
        .select({ id: appFileAssets.id })
        .from(appFileAssets)
        .where(eq(appFileAssets.storageKey, storageKey))
        .limit(1)
    ).length > 0
  );
}

export async function recoverLegacyUser(
  id: string,
  passwordHash: string,
  tx: TransactionContext,
) {
  await tx
    .update(appUsers)
    .set({ passwordHash, status: "enabled", updatedAt: new Date() })
    .where(eq(appUsers.id, id));
}
