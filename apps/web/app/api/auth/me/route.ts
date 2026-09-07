import { getTraceId, ok } from "@pstack/server/api-response";
import { getCurrentUser } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { authToken } from "@pstack/server/request-auth";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    return ok(await getCurrentUser(authToken(request)), traceId);
  });
}
