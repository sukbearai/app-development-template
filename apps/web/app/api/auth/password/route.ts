import { changePasswordRequestSchema } from "@pstack/contracts";
import { fail, getTraceId, ok, readJson } from "@pstack/server/api-response";
import { assertSafeWriteOrigin } from "@pstack/server/api-security";
import { changePassword } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { authToken, clearSessionCookie } from "@pstack/server/request-auth";
import { parseInput } from "@pstack/server/validation";

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      assertSafeWriteOrigin(request);
      const body = parseInput(changePasswordRequestSchema, await readJson(request));
      return clearSessionCookie(ok(await changePassword(body, authToken(request), traceId), traceId));
    } catch (error) {
      return fail(error, traceId);
    }
  });
}
