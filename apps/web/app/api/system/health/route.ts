import { getTraceId, ok } from "@pstack/server/api-response";
import { healthCheck } from "@pstack/server/health-service";
import { withAccessLog } from "@pstack/server/logger";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    const health = await healthCheck();
    return ok(health, traceId, { status: health.status === "ok" ? 200 : 503 });
  });
}
