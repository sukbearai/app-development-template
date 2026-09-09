import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { z, ZodError } from "zod";
import { ApiError } from "./api-response";
import { assertSafeWriteOrigin } from "./api-security";
import { requirePermission } from "./auth-service";

export interface TrpcContext {
  request: Request;
  token: string | undefined;
  traceId: string;
  responseHeaders: Headers;
}

export const rpcRequestContext = new AsyncLocalStorage<TrpcContext>();
const retryDetailsSchema = z.object({ retryAfterSeconds: z.number().int().positive() });

const statusCodes = new Map<number, TRPC_ERROR_CODE_KEY>([
  [400, "BAD_REQUEST"],
  [401, "UNAUTHORIZED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [413, "PAYLOAD_TOO_LARGE"],
  [415, "UNSUPPORTED_MEDIA_TYPE"],
  [429, "TOO_MANY_REQUESTS"],
  [503, "SERVICE_UNAVAILABLE"],
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Arbitrary service exceptions enter the RPC transport at this boundary.
export function rpcError(error: unknown): TRPCError {
  if (error instanceof ApiError)
    return new TRPCError({
      code: statusCodes.get(error.status) ?? "INTERNAL_SERVER_ERROR",
      message: error.message,
      cause: error,
    });
  if (error instanceof TRPCError && error.cause instanceof ApiError) return rpcError(error.cause);
  if (error instanceof TRPCError) return error;
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });
}

export const trpc = initTRPC.context<TrpcContext>().create({
  errorFormatter(options) {
    const { error, ctx } = options;
    const errorBody = options.shape;
    const context = ctx ?? rpcRequestContext.getStore();
    const business = error.cause instanceof ApiError ? error.cause : undefined;
    const validation = error.cause instanceof ZodError ? error.cause : undefined;
    const internal = errorBody.data.httpStatus >= 500 && !business;
    const retry = retryDetailsSchema.safeParse(business?.details);
    if (retry.success)
      context?.responseHeaders.set("retry-after", String(retry.data.retryAfterSeconds));
    return {
      code: errorBody.code,
      message: internal
        ? "服务器暂时无法处理请求"
        : (business?.message ?? (validation ? "请求参数无效" : "请求无法处理")),
      data: {
        code: errorBody.data.code,
        httpStatus: errorBody.data.httpStatus,
        businessCode: internal
          ? "INTERNAL_ERROR"
          : (business?.code ?? (validation ? "VALIDATION_FAILED" : errorBody.data.code)),
        traceId: context?.traceId,
        details: internal
          ? {}
          : (business?.details ??
            (validation
              ? {
                  issues: validation.issues.map(({ path, code }) => ({
                    path,
                    code,
                    message: "请求参数无效",
                  })),
                }
              : {})),
      },
    };
  },
});

export const publicProcedure = trpc.procedure.use(async ({ ctx, type, next }) => {
  try {
    if (type === "mutation") assertSafeWriteOrigin(ctx.request);
    const result = await next();
    if (!result.ok) throw result.error;
    return result;
  } catch (error) {
    throw rpcError(error);
  }
});

export const authenticatedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.token) throw new ApiError(401, "UNAUTHENTICATED", "请先登录");
  return next();
});

export const adminReadProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  await requirePermission(ctx.token, "admin.read");
  return next();
});

export const adminWriteProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  await requirePermission(ctx.token, "admin.write");
  return next();
});
