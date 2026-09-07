import { authToken } from "@pstack/server/request-auth";
import { updateUserRequestSchema } from "@pstack/contracts";
import { getTraceId, ok, readJson } from "@pstack/server/api-response";
import { requireApiWritePermission } from "@/lib/api-authz";
import { updateManagedUser } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { parseInput } from "@pstack/server/validation";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiWritePermission(request, "admin.write");
    const params = await context.params;
    const body = parseInput(updateUserRequestSchema, await readJson(request));
    return ok(await updateManagedUser(params.id, body, authToken(request), traceId), traceId);
  });
}
