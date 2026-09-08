import { telemetryRequestSchema } from "@pstack/contracts";
import { created, getTraceId, readJson } from "@pstack/server/api-response";
import { assertSafeWriteOrigin } from "@pstack/server/api-security";
import { withAccessLog } from "@pstack/server/logger";
import { recordTelemetry } from "@pstack/server/product-service";
import { assertRequestRateLimit } from "@pstack/server/rate-limit";
import { parseInput } from "@pstack/server/validation";

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    await assertRequestRateLimit("telemetry:global", {
      limit: 120,
      windowMs: 60000,
    });
    assertSafeWriteOrigin(request);
    const body = parseInput(telemetryRequestSchema, await readJson(request));
    return created(await recordTelemetry({ event: body.event, route: body.route, payload: body.payload, traceId }), traceId);
  });
}
