"use client";

import { apiFailureSchema, apiSuccessSchema } from "@pstack/contracts/http";
import type { z } from "zod";

type HttpFailure = z.infer<typeof apiFailureSchema>;

type RequestFailure =
  | {
      kind: "http";
      status: number;
      code: string;
      traceId?: string;
      details?: HttpFailure["error"]["details"];
      retryAfterMs?: number;
    }
  | { kind: "invalid-response"; status: number }
  | { kind: "network" | "timeout" | "cancelled" };

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly failure: RequestFailure,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  get kind() {
    return this.failure.kind;
  }
  get status() {
    return "status" in this.failure ? this.failure.status : 0;
  }
  get code() {
    return this.failure.kind === "http"
      ? this.failure.code
      : this.failure.kind.toUpperCase().replaceAll("-", "_");
  }
  get traceId() {
    return this.failure.kind === "http" ? this.failure.traceId : undefined;
  }
  get details() {
    return this.failure.kind === "http" ? this.failure.details : undefined;
  }
  get retryAfterMs() {
    return this.failure.kind === "http" ? this.failure.retryAfterMs : undefined;
  }
}

export type RequestJsonInit = RequestInit & { fallbackMessage?: string; timeoutMs?: number };

export function parseRetryAfter(value: string | null, now = Date.now()) {
  if (!value?.trim()) return undefined;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  if (!/^[A-Z][a-z]{2}, /.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function requestSignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new RangeError("timeoutMs must be a positive timer duration");
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("请求超时", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    dispose: () => clearTimeout(timer),
  };
}

export function parseApiResponse<T>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- HTTP payloads are validated against the supplied schema at this boundary.
  payload: unknown,
  status: number,
  schema: z.ZodType<T>,
  fallbackMessage?: string,
  retryAfter?: string | null,
): T {
  if (status < 200 || status >= 300) {
    const parsed = apiFailureSchema.safeParse(payload);
    throw new ApiRequestError(
      parsed.success ? parsed.data.error.message : fallbackMessage || `请求失败 (${status})`,
      {
        kind: "http",
        status,
        code: parsed.success ? parsed.data.error.code : "INVALID_RESPONSE",
        traceId: parsed.success ? parsed.data.traceId : undefined,
        details: parsed.success ? parsed.data.error.details : undefined,
        retryAfterMs: parseRetryAfter(retryAfter ?? null),
      },
    );
  }
  const parsed = apiSuccessSchema(schema).safeParse(payload);
  if (!parsed.success)
    throw new ApiRequestError(fallbackMessage || "服务器响应格式无效", {
      kind: "invalid-response",
      status,
    });
  return parsed.data.data;
}

async function readResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  fallbackMessage?: string,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return parseApiResponse(
    payload,
    response.status,
    schema,
    fallbackMessage,
    response.headers.get("retry-after"),
  );
}

export async function requestJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestJsonInit = {},
): Promise<T> {
  const { fallbackMessage, timeoutMs = 30_000, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (
    requestInit.body !== undefined &&
    !(requestInit.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const request = requestSignal(requestInit.signal, timeoutMs);
  try {
    const response = await fetch(url, {
      ...requestInit,
      credentials: requestInit.credentials || "same-origin",
      headers,
      signal: request.signal,
    });
    return await readResponse(response, schema, fallbackMessage);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if (request.signal.aborted) {
      const timeout =
        request.signal.reason instanceof DOMException &&
        request.signal.reason.name === "TimeoutError";
      throw new ApiRequestError(timeout ? "请求超时，请稍后重试" : "请求已取消", {
        kind: timeout ? "timeout" : "cancelled",
      });
    }
    throw new ApiRequestError("网络连接失败，请检查网络后重试", { kind: "network" });
  } finally {
    request.dispose();
  }
}

export function requestForm<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestJsonInit & { body: FormData },
): Promise<T> {
  return requestJson(url, schema, { timeoutMs: 120_000, ...init });
}
