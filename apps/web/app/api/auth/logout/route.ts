import { fail, getTraceId, ok } from "@pstack/server/api-response";
import { assertSafeWriteOrigin } from "@pstack/server/api-security";
import { logout } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { authToken, clearSessionCookie } from "@pstack/server/request-auth";

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      assertSafeWriteOrigin(request);
      return clearSessionCookie(ok(await logout(authToken(request)), traceId));
    } catch (error) {
      return fail(error, traceId);
    }
  });
}
