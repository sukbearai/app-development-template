import { randomUUID } from "node:crypto";
import { asyncIdentifierSchema } from "@pstack/contracts";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Error details are validated against the selected response contract before sending.
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createTraceId() {
  return `trace_${randomUUID()}`;
}

export function getTraceId(request: Request) {
  const parsed = asyncIdentifierSchema.safeParse(request.headers.get("x-trace-id"));
  return parsed.success ? parsed.data : createTraceId();
}

export function ok(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- withAccessLog validates the envelope against the selected operation schema.
  data: unknown,
  traceId: string,
  init?: ResponseInit & { meta?: unknown },
) {
  return Response.json({ traceId, data, meta: init?.meta || {} }, init);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- withAccessLog validates data and metadata against the selected operation schema.
export function created(data: unknown, traceId: string, meta?: unknown) {
  return ok(data, traceId, { status: 201, meta });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch values may be arbitrary; only ApiError exposes response details.
export function fail(error: unknown, traceId: string) {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(500, "INTERNAL_ERROR", "服务器暂时无法处理请求");

  return Response.json(
    {
      traceId,
      error: {
        code: apiError.code,
        message: apiError.message,
        details: apiError.details || {},
      },
    },
    { status: apiError.status },
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- This bounded transport decoder returns untrusted JSON for parseInput to validate.
export async function readJson(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  )
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "请求内容类型必须是 application/json",
    );
  if (!request.body)
    throw new ApiError(400, "INVALID_JSON", "请求体必须是有效 JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new ApiError(413, "JSON_TOO_LARGE", "JSON 请求体不能超过 64 KiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体必须是有效 JSON");
  }
}
