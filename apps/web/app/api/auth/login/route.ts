import { loginRequestSchema } from "@pstack/contracts";
import { fail, getTraceId, ok, readJson } from "@pstack/server/api-response";
import { assertSafeWriteOrigin } from "@pstack/server/api-security";
import { login } from "@pstack/server/auth-service";
import { withAccessLog } from "@pstack/server/logger";
import { assertLoginRateLimit, resetLoginRateLimit } from "@pstack/server/rate-limit";
import { setSessionCookie } from "@pstack/server/request-auth";
import { parseInput } from "@pstack/server/validation";

export async function POST(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    try {
      assertSafeWriteOrigin(request);
      const body = parseInput(loginRequestSchema, await readJson(request));
      const rateLimitKey = `login:${body.account}`;
      await assertLoginRateLimit(rateLimitKey);
      const session = await login(body);
      await resetLoginRateLimit(rateLimitKey);
      return setSessionCookie(ok(session, traceId), session.token);
    } catch (error) {
      return fail(error, traceId);
    }
  });
}
