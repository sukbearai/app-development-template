import { getTraceId, ok } from "@pstack/server/api-response";
import { withAccessLog } from "@pstack/server/logger";
import { requireMetricsToken } from "@pstack/server/metrics-auth";
import { runtimeMetricsSnapshot } from "@pstack/server/runtime-metrics";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  const response = await withAccessLog(request, traceId, async () => {
    requireMetricsToken(request);
    return ok(await runtimeMetricsSnapshot(), traceId);
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
