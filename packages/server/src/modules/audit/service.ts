import type { AuditPageQuery } from "@pstack/contracts/modules/audit/contracts";
import { getAuditPage } from "@pstack/database/modules/audit/repository";
import { requirePermission } from "../identity/service";

export async function listAuditPage(token: string | undefined, query: AuditPageQuery) {
  await requirePermission(token, "admin.read");
  return getAuditPage(query);
}
