"use client";

import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@pstack/server/trpc-router";
import { z } from "zod";
import { jsonRecordSchema } from "@pstack/contracts";
import { ApiRequestError, parseRetryAfter } from "./api-client";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

const rpcErrorData = z.object({
  httpStatus: z.number(),
  businessCode: z.string(),
  traceId: z.string(),
  details: jsonRecordSchema.optional(),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Both tRPC and transport failures enter this error boundary.
export function requestError(error: unknown): Error {
  if (!(error instanceof TRPCClientError))
    return error instanceof Error ? error : new Error("请求失败");
  if (error.cause instanceof ApiRequestError) return error.cause;
  const parsed = rpcErrorData.safeParse(error.data);
  if (parsed.success)
    return new ApiRequestError(error.message, {
      kind: "http",
      status: parsed.data.httpStatus,
      code: parsed.data.businessCode,
      traceId: parsed.data.traceId,
      details: parsed.data.details,
      retryAfterMs:
        error.meta?.response instanceof Response
          ? parseRetryAfter(error.meta.response.headers.get("retry-after"))
          : undefined,
    });
  if (error.meta?.response instanceof Response && !error.meta.response.ok) {
    return new ApiRequestError(`请求失败 (${error.meta.response.status})`, {
      kind: "http",
      status: error.meta.response.status,
      code: "INVALID_RESPONSE",
      retryAfterMs: parseRetryAfter(error.meta.response.headers.get("retry-after")),
    });
  }
  return new ApiRequestError("服务器响应格式无效", {
    kind: "invalid-response",
    status: error.meta?.response instanceof Response ? error.meta.response.status : 0,
  });
}

export const rpcFetch: typeof fetch = async (input, init) => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetch(input, { ...init, signal, credentials: "same-origin" });
    const body = await response.arrayBuffer();
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw response.ok
        ? new ApiRequestError("服务器响应格式无效", {
            kind: "invalid-response",
            status: response.status,
          })
        : new ApiRequestError(`请求失败 (${response.status})`, {
            kind: "http",
            status: response.status,
            code: "INVALID_RESPONSE",
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          });
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if (init?.signal?.aborted) throw new ApiRequestError("请求已取消", { kind: "cancelled" });
    if (timeout.signal.aborted) throw new ApiRequestError("请求超时，请重试", { kind: "timeout" });
    throw new ApiRequestError("网络连接失败，请检查网络", { kind: "network" });
  } finally {
    clearTimeout(timer);
  }
};

export function createBrowserRpcClient() {
  return createTRPCClient<AppRouter>({ links: [httpLink({ url: "/api/trpc", fetch: rpcFetch })] });
}
