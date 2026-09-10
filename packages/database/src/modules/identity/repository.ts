import type {
  User,
  Role,
  AuthSession,
  Permission,
  UserPage,
  UserPageQuery,
} from "@pstack/contracts/modules/identity/contracts";

import {
  appUsers,
  appRoles,
  appUserSessions,
  appUserRoles,
  appRolePermissions,
  appPermissions,
} from "../../schema";

import { iso, containsText } from "../../row-values.ts";

import { asc, eq, and, sql, count, desc, ilike, inArray, or } from "drizzle-orm";

import { getDatabase, type DatabaseContext, type TransactionContext } from "../../client";

function mapUser(row: typeof appUsers.$inferSelect, roleIds: string[] = []): User {
  return {
    id: row.id,
    account: row.account,
    displayName: row.displayName,
    status: row.status,
    roleIds,
    createdAt: iso(row.createdAt),
  };
}

function mapRole(row: typeof appRoles.$inferSelect, permissionIds: string[] = []): Role {
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
    roleIdsByUser.set(row.userId, [...(roleIdsByUser.get(row.userId) || []), row.roleId]);
  }
  return userRows.map((row) => mapUser(row, roleIdsByUser.get(row.id) || []));
}

export async function getUserByAccount(account: string, context: DatabaseContext = getDatabase()) {
  const database = context;
  const row = (
    await database.select().from(appUsers).where(eq(appUsers.account, account)).limit(1)
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

export async function getUserById(userId: string, context: DatabaseContext = getDatabase()) {
  const database = context;
  const row = (await database.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1))[0];
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
  return roleRows.map((row) => mapRole(row, permissionIdsByRole.get(row.id) || []));
}

export async function getPermissions(context: DatabaseContext = getDatabase()) {
  const database = context;
  const rows = await database.select().from(appPermissions).orderBy(asc(appPermissions.id));
  return rows.map((row): Permission => ({ id: row.id, name: row.name }));
}

export async function createUser(
  input: User & { passwordHash: string },
  context: TransactionContext,
) {
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
  {
    const tx = context;
    const changes: Partial<typeof appUsers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.displayName !== undefined) changes.displayName = input.displayName;
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
  {
    const tx = context;
    await tx.insert(appRoles).values({ id: input.id, name: input.name, status: input.status });
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
  {
    const tx = context;
    const changes: Partial<typeof appRoles.$inferInsert> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.status !== undefined) changes.status = input.status;
    if (Object.keys(changes).length) {
      await tx.update(appRoles).set(changes).where(eq(appRoles.id, input.id));
    }
    if (input.permissionIds) {
      await tx.delete(appRolePermissions).where(eq(appRolePermissions.roleId, input.id));
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

export async function getSession(sessionId: string, context: DatabaseContext = getDatabase()) {
  const row = (
    await context.select().from(appUserSessions).where(eq(appUserSessions.id, sessionId)).limit(1)
  )[0];
  return row ? mapSession(row) : undefined;
}

export async function touchSession(sessionId: string, context: TransactionContext) {
  await context
    .update(appUserSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(appUserSessions.id, sessionId));
}

export async function revokeSession(sessionId: string, context: TransactionContext) {
  await context
    .update(appUserSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(appUserSessions.id, sessionId),
        sql`${appUserSessions.revokedAt} is null`,
        sql`${appUserSessions.expiresAt} > now()`,
      ),
    );
}

export async function lockIdentity(context: TransactionContext) {
  await context.execute(sql`select pg_advisory_xact_lock(741829310)`);
}

export async function revokeUserSessions(userId: string, context: TransactionContext) {
  await context
    .update(appUserSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(appUserSessions.userId, userId),
        sql`${appUserSessions.revokedAt} is null`,
        sql`${appUserSessions.expiresAt} > now()`,
      ),
    );
}

export async function recoverLegacyUser(id: string, passwordHash: string, tx: TransactionContext) {
  await tx
    .update(appUsers)
    .set({ passwordHash, status: "enabled", updatedAt: new Date() })
    .where(eq(appUsers.id, id));
}

export async function getUserCredentialsById(
  userId: string,
  context: DatabaseContext = getDatabase(),
) {
  const [row] = await context.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1);
  if (!row) return undefined;
  const roles = await context.select().from(appUserRoles).where(eq(appUserRoles.userId, userId));
  return {
    user: mapUser(
      row,
      roles.map((role) => role.roleId),
    ),
    passwordHash: row.passwordHash,
  };
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string,
  tx: TransactionContext,
) {
  await tx
    .update(appUsers)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(appUsers.id, userId));
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
