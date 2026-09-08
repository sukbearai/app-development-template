import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthSession,
  ChangePasswordRequest,
  ResetUserPasswordRequest,
  CreateRoleRequest,
  CreateUserRequest,
  Role,
  UpdateRoleRequest,
  UpdateUserRequest,
  User,
} from "@pstack/contracts";
import {
  changePasswordRequestSchema,
  resetUserPasswordRequestSchema,
  loginRequestSchema,
  createUserRequestSchema,
} from "@pstack/contracts";
import { parseInput } from "./validation";
import { assertRequestRateLimit } from "./rate-limit";
import { ApiError } from "./api-response";
import { env } from "./env";
import { hashPassword, verifyPassword } from "./password";
import {
  withTransaction,
  type TransactionContext,
} from "@pstack/database/client";
import { recordAudit } from "./product-service";
import * as repo from "@pstack/database/repository";

const tokenPartBytes = 24;
const sessionTtlSeconds = env.SESSION_TTL_SECONDS;

type StoredSession = AuthSession & { secretHash: string; revokedAt?: string };

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}

function generateSessionToken() {
  const id = base64Url(randomBytes(tokenPartBytes));
  const secret = base64Url(randomBytes(tokenPartBytes));
  return { id, secret, token: `${id}.${secret}` };
}

function hashSessionSecret(secret: string) {
  return createHash("sha256").update(secret).digest("base64url");
}

function verifySessionSecret(secret: string, secretHash: string) {
  const actual = Buffer.from(hashSessionSecret(secret));
  const expected = Buffer.from(secretHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseSessionToken(token?: string) {
  const [id, secret, extra] = String(token || "").split(".");
  if (!id || !secret || extra !== undefined) return undefined;
  return { id, secret };
}

function publicSession(session: AuthSession): AuthSession {
  return {
    id: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
  };
}

function permissionsForUser(user: User, roles: Role[]) {
  const roleIds = new Set(user.roleIds);
  return new Set(
    roles
      .filter((role) => role.status === "active" && roleIds.has(role.id))
      .flatMap((role) => role.permissionIds),
  );
}

async function sessionActor(token: string | undefined, tx: TransactionContext) {
  const parsed = parseSessionToken(token);
  if (!parsed) return undefined;
  const session = await repo.getSession(parsed.id, tx);
  if (
    !session ||
    session.revokedAt ||
    Date.parse(session.expiresAt) <= Date.now() ||
    !verifySessionSecret(parsed.secret, session.secretHash)
  )
    return undefined;
  const user = await repo.getUserById(session.userId, tx);
  return user?.status === "enabled" ? { session, user } : undefined;
}
async function sessionActorAsync(token?: string) {
  return withTransaction(async (tx) => {
    const actor = await sessionActor(token, tx);
    if (actor) await repo.touchSession(actor.session.id, tx);
    return actor;
  });
}
export async function requireWritePermission(
  token: string | undefined,
  permissionId: string,
  tx: TransactionContext,
) {
  await repo.lockIdentity(tx);
  const actor = await sessionActor(token, tx);
  if (!actor) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  if (
    !permissionsForUser(actor.user, await repo.getRoles(tx)).has(permissionId)
  )
    throw new ApiError(403, "FORBIDDEN", "无权限执行该操作", {
      permission: permissionId,
    });
  return actor.user;
}

export async function login(input: { account?: string; password?: string }) {
  const { account, password } = parseInput(loginRequestSchema, input);
  const accountRecord = await repo.getUserByAccount(account);
  const user = accountRecord?.user;
  const passwordHash = accountRecord?.passwordHash || "";
  const passwordMatches = await verifyPassword(password, passwordHash);
  if (
    !user ||
    user.status !== "enabled" ||
    !passwordMatches
  ) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
  }
  const generated = generateSessionToken();
  const now = new Date();
  const session: StoredSession = {
    id: generated.id,
    userId: user.id,
    secretHash: hashSessionSecret(generated.secret),
    expiresAt: new Date(now.getTime() + sessionTtlSeconds * 1000).toISOString(),
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
  };
  await withTransaction(async (tx) => {
    await repo.lockIdentity(tx);
    const current = await repo.getUserByAccount(account, tx);
    if (
      current?.user.status !== "enabled" ||
      current.passwordHash !== passwordHash
    )
      throw new ApiError(401, "INVALID_CREDENTIALS", "账号或密码错误");
    await repo.saveSession(session, tx);
    await recordAudit(
      {
        actorId: user.id,
        action: "auth.login",
        targetType: "user",
        targetId: user.id,
        traceId: "login",
      },
      tx,
    );
  });

  const currentRoles = await listRoles();
  const currentPermissions = await listPermissions();
  const userPermissionIds = permissionsForUser(user, currentRoles);
  return {
    token: generated.token,
    session: publicSession(session),
    user,
    roles: currentRoles.filter(
      (role) => role.status === "active" && user.roleIds.includes(role.id),
    ),
    permissions: currentPermissions.filter((permission) =>
      userPermissionIds.has(permission.id),
    ),
  };
}

export async function getCurrentUser(token?: string) {
  const actor = await sessionActorAsync(token);
  if (!actor?.user) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  const user = actor.user;
  const currentRoles = await listRoles();
  const currentPermissions = await listPermissions();
  const userPermissionIds = permissionsForUser(user, currentRoles);
  return {
    session: publicSession(actor.session),
    user,
    roles: currentRoles.filter(
      (role) => role.status === "active" && user.roleIds.includes(role.id),
    ),
    permissions: currentPermissions.filter((permission) =>
      userPermissionIds.has(permission.id),
    ),
  };
}

export async function listUsers() {
  return repo.getUsers();
}

export async function listRoles() {
  return repo.getRoles();
}

export async function listPermissions() {
  return repo.getPermissions();
}

export async function createManagedUser(
  input: CreateUserRequest,
  token: string | undefined,
  traceId = "admin",
) {
  input = parseInput(createUserRequestSchema, input);
  await requirePermission(token, "admin.write");
  const passwordHash = await hashPassword(input.password);
  return identityTransaction(async (tx) => {
    const actorId = (await requireWritePermission(token, "admin.write", tx)).id;
    if (await repo.getUserByAccount(input.account, tx)) {
      throw new ApiError(409, "ACCOUNT_EXISTS", "账号已存在");
    }
    const now = new Date().toISOString();
    const user: User = {
      id: `user_${base64Url(randomBytes(12))}`,
      account: input.account,
      displayName: input.displayName,
      status: input.status,
      roleIds: input.roleIds,
      createdAt: now,
    };
    await repo.createUser({ ...user, passwordHash }, tx);
    await recordAudit(
      {
        actorId,
        action: "admin.user.create",
        targetType: "user",
        targetId: user.id,
        traceId,
      },
      tx,
    );
    return user;
  });
}

export async function updateManagedUser(
  userId: string,
  input: UpdateUserRequest,
  token: string | undefined,
  traceId = "admin",
) {
  return identityTransaction(async (tx) => {
    const actorId = (await requireWritePermission(token, "admin.write", tx)).id;
    const existing = await repo.getUserById(userId, tx);
    if (!existing) throw new ApiError(404, "USER_NOT_FOUND", "用户不存在");
    const updated: User = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      status: input.status ?? existing.status,
      roleIds: input.roleIds ?? existing.roleIds,
    };
    await repo.updateUser(
      {
        id: userId,
        displayName: input.displayName,
        status: input.status,
        roleIds: input.roleIds,
      },
      tx,
    );
    if (updated.status === "disabled")
      await repo.revokeUserSessions(userId, tx);
    await assertAdministratorRemains(tx);
    await recordAudit(
      {
        actorId,
        action: "admin.user.update",
        targetType: "user",
        targetId: userId,
        traceId,
      },
      tx,
    );
    return updated;
  });
}

export async function createManagedRole(
  input: CreateRoleRequest,
  token: string | undefined,
  traceId = "admin",
) {
  return identityTransaction(async (tx) => {
    const actorId = (await requireWritePermission(token, "admin.write", tx)).id;
    const existing = (await repo.getRoles(tx)).some(
      (item) => item.id === input.id,
    );
    if (existing) {
      throw new ApiError(409, "ROLE_EXISTS", "角色已存在");
    }
    const role: Role = {
      id: input.id,
      name: input.name,
      permissionIds: input.permissionIds,
      status: input.status,
    };
    await repo.createRole(role, tx);
    await recordAudit(
      {
        actorId,
        action: "admin.role.create",
        targetType: "role",
        targetId: role.id,
        traceId,
      },
      tx,
    );
    return role;
  });
}

export async function updateManagedRole(
  roleId: string,
  input: UpdateRoleRequest,
  token: string | undefined,
  traceId = "admin",
) {
  return identityTransaction(async (tx) => {
    const actorId = (await requireWritePermission(token, "admin.write", tx)).id;
    const currentRoles = await repo.getRoles(tx);
    const existing = currentRoles.find((item) => item.id === roleId);
    if (!existing) throw new ApiError(404, "ROLE_NOT_FOUND", "角色不存在");
    const updated: Role = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      permissionIds: input.permissionIds ?? existing.permissionIds,
    };
    await repo.updateRole(
      {
        id: roleId,
        name: input.name,
        status: input.status,
        permissionIds: input.permissionIds,
      },
      tx,
    );
    await assertAdministratorRemains(tx);
    await recordAudit(
      {
        actorId,
        action: "admin.role.update",
        targetType: "role",
        targetId: roleId,
        traceId,
      },
      tx,
    );
    return updated;
  });
}

export async function requirePermission(
  token: string | undefined,
  permissionId: string,
) {
  const actor = await sessionActorAsync(token);
  if (!actor?.user) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  const currentRoles = await listRoles();
  const permissionIds = permissionsForUser(actor.user, currentRoles);
  if (!permissionIds.has(permissionId))
    throw new ApiError(403, "FORBIDDEN", "无权限执行该操作", {
      permission: permissionId,
    });
  return actor.user;
}

export function requireResourceOwner(
  actor: Pick<User, "id">,
  resource: { ownerId?: string | null },
  action = "resource.access",
) {
  if (resource.ownerId && resource.ownerId === actor.id) return;
  throw new ApiError(403, "FORBIDDEN", "无权访问该资源", { action });
}

export async function logout(token?: string) {
  const parsed = parseSessionToken(token);
  if (!parsed) return { ok: true };
  await withTransaction(async (tx) => {
    await repo.lockIdentity(tx);
    const session = await repo.getSession(parsed.id, tx);
    if (!session || !verifySessionSecret(parsed.secret, session.secretHash))
      return;
    await repo.revokeSession(session.id, tx);
    await recordAudit(
      {
        actorId: session.userId,
        action: "auth.logout",
        targetType: "session",
        targetId: session.id,
        traceId: "logout",
      },
      tx,
    );
  });
  return { ok: true };
}

async function assertAdministratorRemains(tx: TransactionContext) {
  const users = await repo.getUsers(tx);
  const roles = await repo.getRoles(tx);
  const required = ["admin.read", "admin.write"];
  if (
    !users.some(
      (user) =>
        user.status === "enabled" &&
        required.every((permission) =>
          permissionsForUser(user, roles).has(permission),
        ),
    )
  ) {
    throw new ApiError(
      409,
      "LAST_ADMINISTRATOR",
      "必须保留至少一名可管理用户和角色的管理员",
    );
  }
}

async function identityTransaction<T>(
  operation: (tx: TransactionContext) => Promise<T>,
) {
  try {
    return await withTransaction(operation);
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (cause && typeof cause === "object" && "code" in cause) {
      if (cause.code === "23505")
        throw new ApiError(409, "IDENTITY_EXISTS", "账号或角色已存在");
      if (cause.code === "23503")
        throw new ApiError(400, "INVALID_REFERENCE", "角色或权限不存在");
    }
    throw error;
  }
}

export async function changePassword(
  input: ChangePasswordRequest,
  token: string | undefined,
  traceId = "password-change",
): Promise<{ reauthenticate: true }> {
  const parsed = parseInput(changePasswordRequestSchema, input);
  const initial = await sessionActorAsync(token);
  if (!initial) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  await assertRequestRateLimit(`password-change:${initial.user.id}`);
  const previous = await repo.getUserCredentialsById(initial.user.id);
  if (
    !previous ||
    !(await verifyPassword(parsed.currentPassword, previous.passwordHash))
  )
    throw new ApiError(403, "INVALID_CURRENT_PASSWORD", "当前密码错误");
  const passwordHash = await hashPassword(parsed.newPassword);
  return withTransaction(async (tx) => {
    await repo.lockIdentity(tx);
    const actor = await sessionActor(token, tx);
    if (!actor || actor.user.id !== initial.user.id)
      throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
    const current = await repo.getUserCredentialsById(actor.user.id, tx);
    if (current?.passwordHash !== previous.passwordHash)
      throw new ApiError(409, "CREDENTIALS_CHANGED", "密码已变更，请重新登录");
    await replacePassword(
      actor.user.id, passwordHash, actor.user.id, "auth.password.change", traceId, tx,
    );
    return { reauthenticate: true };
  });
}

export async function resetManagedUserPassword(
  userId: string,
  input: ResetUserPasswordRequest,
  token: string | undefined,
  traceId = "password-reset",
): Promise<{ updated: true }> {
  const parsed = parseInput(resetUserPasswordRequestSchema, input);
  const initial = await requirePermission(token, "admin.write");
  if (initial.id === userId)
    throw new ApiError(403, "CURRENT_PASSWORD_REQUIRED", "修改自己的密码需要验证当前密码");
  const previous = await repo.getUserCredentialsById(userId);
  if (!previous) throw new ApiError(404, "USER_NOT_FOUND", "用户不存在");
  const passwordHash = await hashPassword(parsed.newPassword);
  return withTransaction(async (tx) => {
    const actor = await requireWritePermission(token, "admin.write", tx);
    if (actor.id === userId)
      throw new ApiError(403, "CURRENT_PASSWORD_REQUIRED", "修改自己的密码需要验证当前密码");
    const current = await repo.getUserCredentialsById(userId, tx);
    if (!current) throw new ApiError(404, "USER_NOT_FOUND", "用户不存在");
    if (current.passwordHash !== previous.passwordHash)
      throw new ApiError(409, "CREDENTIALS_CHANGED", "密码已变更，请刷新后重试");
    await replacePassword(
      userId, passwordHash, actor.id, "admin.user.password.reset", traceId, tx,
    );
    return { updated: true };
  });
}

async function replacePassword(
  userId: string,
  passwordHash: string,
  actorId: string,
  action: string,
  traceId: string,
  tx: TransactionContext,
) {
  await repo.updateUserPassword(userId, passwordHash, tx);
  await repo.revokeUserSessions(userId, tx);
  await recordAudit({ actorId, action, targetType: "user", targetId: userId, traceId }, tx);
}
