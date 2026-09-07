import { getTraceId, ok } from "@pstack/server/api-response";
import { requireApiPermission } from "@/lib/api-authz";
import { withAccessLog } from "@pstack/server/logger";
import { listOutboxEvents } from "@pstack/server/product-service";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await requireApiPermission(request, "admin.read");
    return ok(await listOutboxEvents(), traceId);
  });
}
