import type { AuditPageQuery, UserPageQuery } from "@pstack/contracts/admin-pages";
import { getAuditPage, getUserPage } from "@pstack/database/admin-pages";
import { requirePermission } from "./auth-service";

export async function listUserPage(token: string | undefined, query: UserPageQuery) {
  await requirePermission(token, "admin.read");
  return getUserPage(query);
}

export async function listAuditPage(token: string | undefined, query: AuditPageQuery) {
  await requirePermission(token, "admin.read");
  return getAuditPage(query);
}
