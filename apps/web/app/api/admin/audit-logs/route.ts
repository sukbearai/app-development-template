import { auditPageQuerySchema, readPageSearchParams } from "@pstack/contracts/admin-pages";
import { getTraceId, ok } from "@pstack/server/api-response";
import { authToken } from "@pstack/server/request-auth";
import { parseInput } from "@pstack/server/validation";
import { withAccessLog } from "@pstack/server/logger";
import { listAuditPage } from "@pstack/server/admin-directory-service";

export async function GET(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () => {
    const query = parseInput(
      auditPageQuerySchema,
      readPageSearchParams(new URL(request.url).searchParams),
    );
    return ok(await listAuditPage(authToken(request), query), traceId);
  });
}
