"use client";

import { z } from "zod";

const errorEnvelope = z.object({
  traceId: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly traceId?: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The error envelope explicitly permits arbitrary diagnostic details.
    readonly details?: unknown,
  ) { super(message); }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates an untrusted HTTP failure envelope.
export function apiErrorMessage(payload: unknown, fallback: string) {
  const parsed = errorEnvelope.safeParse(payload);
  return parsed.success ? parsed.data.error.message : fallback;
}

type RequestJsonInit = RequestInit & { fallbackMessage?: string };

export async function requestJson<T>(url: string, schema: z.ZodType<T>, init: RequestJsonInit = {}): Promise<T> {
  const { fallbackMessage, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  if (requestInit.body !== undefined && !(requestInit.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...requestInit, credentials: requestInit.credentials || "same-origin", headers });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorEnvelope.safeParse(payload);
    if (parsed.success) {
      const { error, traceId } = parsed.data;
      throw new ApiRequestError(error.message, response.status, error.code, traceId, error.details);
    }
    throw new ApiRequestError(fallbackMessage || `请求失败 (${response.status})`, response.status, "INVALID_RESPONSE");
  }
  return z.object({ traceId: z.string(), data: schema }).parse(payload).data;
}

export function requestForm<T>(url: string, schema: z.ZodType<T>, init: RequestJsonInit & { body: FormData }): Promise<T> {
  return requestJson(url, schema, init);
}
