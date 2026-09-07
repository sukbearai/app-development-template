import { authToken } from "@pstack/server/request-auth";
import { createUserRequestSchema } from "@pstack/contracts";
import { fail, getTraceId, ok, readJson } from "@pstack/server/api-response";
import { requireApiPermission, requireApiWritePermission } from "@/lib/api-authz";
import { createManagedUser, listPermissions, listRoles, listUsers } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { parseInput } from "@pstack/server/validation";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      await requireApiPermission(request, "admin.read");
      return ok({ users: await listUsers(), roles: await listRoles(), permissions: await listPermissions() }, traceId);
    } catch (error) {
      return fail(error, traceId);
    }
  });
}

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      await requireApiWritePermission(request, "admin.write");
      const body = parseInput(createUserRequestSchema, await readJson(request));
      return ok(await createManagedUser(body, authToken(request), traceId), traceId, { status: 201 });
    } catch (error) {
      return fail(error, traceId);
    }
  });
}
