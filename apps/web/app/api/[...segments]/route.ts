import { ApiError, fail, getTraceId } from "@pstack/server/api-response";
import { withAccessLog } from "@pstack/server/logger";

function notFound(request: Request) {
  const traceId = getTraceId(request);
  return withAccessLog(request, traceId, async () =>
    fail(
      new ApiError(404, "ROUTE_NOT_FOUND", `未找到接口: ${new URL(request.url).pathname}`),
      traceId,
    ),
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
