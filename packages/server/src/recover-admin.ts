import { z } from "zod";
import { passwordSchema } from "@pstack/contracts";
import { withTransaction } from "@pstack/database/client";
import * as repo from "@pstack/database/repository";
import { hashPassword } from "./password";
import { recordAudit } from "./product-service";

const recoveryInputSchema = z.object({
  account: z.string().trim().min(1).max(100),
  newPassword: passwordSchema.min(16).max(256),
  confirm: z.literal(true),
});

export async function recoverAdministrator(input: z.input<typeof recoveryInputSchema>) {
  const parsed = recoveryInputSchema.parse(input);
  const previous = await repo.getUserByAccount(parsed.account);
  if (!previous || !previous.passwordHash.startsWith("scrypt:"))
    throw new Error("Recovery requires an existing administrator with modern credentials");
  const passwordHash = await hashPassword(parsed.newPassword);
  return withTransaction(async (tx) => {
    await repo.lockIdentity(tx);
    const current = await repo.getUserByAccount(parsed.account, tx);
    const roles = await repo.getRoles(tx);
    const permissions = new Set(
      roles
        .filter((role) => role.status === "active" && current?.user.roleIds.includes(role.id))
        .flatMap((role) => role.permissionIds),
    );
    if (
      !current ||
      current.user.status !== "enabled" ||
      !permissions.has("admin.read") ||
      !permissions.has("admin.write")
    )
      throw new Error("Recovery requires an enabled administrator");
    if (current.passwordHash !== previous.passwordHash)
      throw new Error("Credentials changed during recovery; retry explicitly");
    await repo.updateUserPassword(current.user.id, passwordHash, tx);
    await repo.revokeUserSessions(current.user.id, tx);
    await recordAudit(
      {
        actorId: current.user.id,
        action: "admin.credentials.recovered",
        targetType: "user",
        targetId: current.user.id,
        traceId: "operator-recovery",
        metadata: { channel: "operator-cli" },
      },
      tx,
    );
    return { id: current.user.id, recovered: true };
  });
}
