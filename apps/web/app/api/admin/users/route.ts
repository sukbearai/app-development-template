import { userPageQuerySchema, readPageSearchParams } from "@pstack/contracts/admin-pages";
import { listUserPage } from "@pstack/server/admin-directory-service";
import { authToken } from "@pstack/server/request-auth";
import { createUserRequestSchema } from "@pstack/contracts";
import { getTraceId, ok, readJson } from "@pstack/server/api-response";
import { requireApiWritePermission } from "@/lib/api-authz";
import { createManagedUser, listPermissions, listRoles } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { parseInput } from "@pstack/server/validation";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    const query = parseInput(
      userPageQuerySchema,
      readPageSearchParams(new URL(request.url).searchParams),
    );
    const result = await listUserPage(authToken(request), query);
    return ok(
      {
        users: result.items,
        page: result.page,
        limit: result.limit,
        total: result.total,
        roles: await listRoles(),
        permissions: await listPermissions(),
      },
      traceId,
    );
  });
}

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiWritePermission(request, "admin.write");
    const body = parseInput(createUserRequestSchema, await readJson(request));
    return ok(await createManagedUser(body, authToken(request), traceId), traceId, { status: 201 });
  });
}
