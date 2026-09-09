import { passwordSchema } from "@pstack/contracts";
import { randomUUID } from "node:crypto";
import { withTransaction } from "@pstack/database/client";
import * as repo from "@pstack/database/repository";
import { appPermissions } from "@pstack/database/schema";
import { hashPassword, verifyPassword } from "./password";
import { recordAudit } from "./product-service";
import { z } from "zod";
const inputSchema = z.object({
  account: z.string().trim().min(3).max(100),
  password: passwordSchema.min(16).max(256),
  displayName: z.string().trim().min(1).max(100).default("管理员"),
});
export async function bootstrapAdministrator(
  input: z.input<typeof inputSchema>,
  options: { recoverLegacy?: boolean } = {},
) {
  const parsed = inputSchema.parse(input);
  const previous = await repo.getUserByAccount(parsed.account);
  const matchesPrevious = previous
    ? await verifyPassword(parsed.password, previous.passwordHash)
    : false;
  const passwordHash = await hashPassword(parsed.password);
  return withTransaction(async (tx) => {
    await repo.lockIdentity(tx);
    const existing = await repo.getUserByAccount(parsed.account, tx);
    if (existing) {
      const roles = await repo.getRoles(tx);
      const admin = roles.some(
        (role) =>
          existing.user.roleIds.includes(role.id) &&
          role.status === "active" &&
          role.permissionIds.includes("admin.write") &&
          role.permissionIds.includes("admin.read"),
      );
      if (
        options.recoverLegacy &&
        existing.passwordHash.startsWith("plain:") &&
        existing.user.status === "disabled" &&
        admin
      ) {
        await repo.recoverLegacyUser(existing.user.id, passwordHash, tx);
        await repo.revokeUserSessions(existing.user.id, tx);
        await recordAudit(
          {
            actorId: existing.user.id,
            action: "admin.legacy_credentials_recovered",
            targetType: "user",
            targetId: existing.user.id,
            traceId: "bootstrap",
          },
          tx,
        );
        return { id: existing.user.id, created: false };
      }
      if (
        existing.user.status !== "enabled" ||
        !admin ||
        existing.passwordHash !== previous?.passwordHash ||
        !matchesPrevious
      )
        throw new Error("Bootstrap account exists with different credentials or privileges");
      return { id: existing.user.id, created: false };
    }
    if ((await repo.getUsers(tx)).length)
      throw new Error("Bootstrap requires an empty user database");
    const permissions = [
      { id: "system.read", name: "查看系统状态" },
      { id: "admin.read", name: "查看后台" },
      { id: "admin.write", name: "管理后台数据" },
      { id: "file.upload", name: "上传文件" },
    ];
    await tx.insert(appPermissions).values(permissions).onConflictDoNothing();
    const roles = await repo.getRoles(tx);
    if (!roles.some((role) => role.id === "role_admin"))
      await repo.createRole(
        {
          id: "role_admin",
          name: "管理员",
          status: "active",
          permissionIds: permissions.map((permission) => permission.id),
        },
        tx,
      );
    else
      await repo.updateRole(
        {
          id: "role_admin",
          status: "active",
          permissionIds: permissions.map((permission) => permission.id),
        },
        tx,
      );
    const id = `user_${randomUUID()}`;
    await repo.createUser(
      {
        id,
        account: parsed.account,
        displayName: parsed.displayName,
        passwordHash,
        status: "enabled",
        roleIds: ["role_admin"],
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    await recordAudit(
      {
        actorId: id,
        action: "admin.bootstrap",
        targetType: "user",
        targetId: id,
        traceId: "bootstrap",
      },
      tx,
    );
    return { id, created: true };
  });
}
