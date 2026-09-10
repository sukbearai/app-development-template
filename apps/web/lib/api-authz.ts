import { assertSafeWriteOrigin } from "@pstack/server/api-security";
import { requirePermission } from "@pstack/server/modules/identity/service";
import { authToken } from "@pstack/server/request-auth";

/**
 * Route-handler authz helper for authenticated API reads.
 * Prefer this over calling requirePermission(authToken(request), ...) at each route.
 */
export async function requireApiPermission(request: Request, permissionId: string) {
  return requirePermission(authToken(request), permissionId);
}

/**
 * Route-handler authz helper for cookie/bearer authenticated API writes.
 * Enforces same-origin checks first, then RBAC permission.
 */
export async function requireApiWritePermission(request: Request, permissionId: string) {
  assertSafeWriteOrigin(request);
  return requireApiPermission(request, permissionId);
}
