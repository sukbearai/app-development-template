import { isWebDraining } from "@pstack/database/process-lifecycle";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import * as rpcCore from "@trpc/server/unstable-core-do-not-import";
import { ApiError, getTraceId, readJsonText } from "./api-response";
import { assertSafeWriteOrigin } from "./api-security";
import { withAccessLog, logger, errorDiagnostic } from "./logger";
import { assertOverallLoginRateLimit } from "./rate-limit";
import { authToken } from "./request-auth";
import { appRouter } from "./trpc-router";
import { recordRpcMetric, rpcProcedurePath } from "./trpc-metrics";
import { rpcError, rpcRequestContext, trpc, type TrpcContext } from "./trpc";

const endpoint = "/api/trpc";

async function readRpcBody(request: Request) {
  const body = await readJsonText(request);
  if (body) {
    try {
      JSON.parse(body);
    } catch {
      throw new ApiError(400, "INVALID_JSON", "请求体必须是有效 JSON");
    }
  }
  return body;
}

async function prepareRequest(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.has("batch") || url.pathname.includes(","))
    throw new ApiError(400, "BATCHING_DISABLED", "不支持批量请求");
  if (request.method !== "POST") return request;
  assertSafeWriteOrigin(request);
  if (url.pathname.replace(/\/+$/, "") === `${endpoint}/auth.login`)
    await assertOverallLoginRateLimit();
  const body = await readRpcBody(request);
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body || undefined,
    signal: request.signal,
  });
}

function failureResponse(context: TrpcContext, cause: Error) {
  const error = rpcCore.getErrorShape({
    config: trpc._config,
    error: rpcError(cause),
    type: "unknown",
    path: undefined,
    input: undefined,
    ctx: context,
  });
  return Response.json(
    { error },
    { status: error.data.httpStatus, headers: context.responseHeaders },
  );
}

async function dispatchRequest(context: TrpcContext) {
  try {
    const request = await prepareRequest(context.request);
    return await fetchRequestHandler({
      endpoint,
      req: request,
      router: appRouter,
      allowBatching: false,
      createContext: () => context,
      responseMeta: () => ({ headers: new Headers(context.responseHeaders) }),
      onError: ({ error }) => {
        const level = error.code === "INTERNAL_SERVER_ERROR" ? "error" : "warn";
        logger[level]("rpc request failed", {
          traceId: context.traceId,
          procedure: rpcProcedurePath(new URL(context.request.url).pathname),
          code: error.code,
          error: errorDiagnostic(error),
        });
      },
    });
  } catch (cause) {
    return failureResponse(context, rpcError(cause));
  }
}

export function handleTrpcRequest(request: Request) {
  const traceId = getTraceId(request);
  const context: TrpcContext = {
    request,
    token: authToken(request),
    traceId,
    responseHeaders: new Headers({ "x-trace-id": traceId }),
  };
  if (isWebDraining())
    return Promise.resolve(
      failureResponse(
        context,
        new ApiError(503, "SERVICE_UNAVAILABLE", "服务正在停止，请稍后重试"),
      ),
    );
  return withAccessLog(request, traceId, () =>
    rpcRequestContext.run(context, async () => {
      const startedAt = performance.now();
      const response = await dispatchRequest(context);
      recordRpcMetric(
        new URL(request.url).pathname,
        response.status,
        performance.now() - startedAt,
      );
      return response;
    }),
  );
}
