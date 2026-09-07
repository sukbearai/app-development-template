import { resetUserPasswordRequestSchema } from "@pstack/contracts";
import { fail, getTraceId, ok, readJson } from "@pstack/server/api-response";
import { resetManagedUserPassword } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { authToken } from "@pstack/server/request-auth";
import { parseInput } from "@pstack/server/validation";
import { requireApiWritePermission } from "@/lib/api-authz";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      await requireApiWritePermission(request, "admin.write");
      const { id } = await context.params;
      const body = parseInput(resetUserPasswordRequestSchema, await readJson(request));
      return ok(await resetManagedUserPassword(id, body, authToken(request), traceId), traceId);
    } catch (error) {
      return fail(error, traceId);
    }
  });
}
