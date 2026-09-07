import { authToken } from "@pstack/server/request-auth";
import { createRoleRequestSchema } from "@pstack/contracts";
import { getTraceId, ok, readJson } from "@pstack/server/api-response";
import { requireApiPermission, requireApiWritePermission } from "@/lib/api-authz";
import { createManagedRole, listRoles } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { parseInput } from "@pstack/server/validation";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiPermission(request, "admin.read");
    return ok(await listRoles(), traceId);
  });
}

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiWritePermission(request, "admin.write");
    const body = parseInput(createRoleRequestSchema, await readJson(request));
    return ok(await createManagedRole(body, authToken(request), traceId), traceId, { status: 201 });
  });
}
