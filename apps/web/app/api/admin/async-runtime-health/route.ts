import { getTraceId, ok } from "@pstack/server/api-response";
import { requireApiPermission } from "@/lib/api-authz";
import { readAdminAsyncRuntimeHealth } from "@pstack/server/async-runtime-health-service";
import { withAccessLog } from "@pstack/server/logger";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiPermission(request, "admin.read");
    return ok(await readAdminAsyncRuntimeHealth(), traceId);
  });
}
