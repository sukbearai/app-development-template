import { env } from "./env";
import { assertRequestRateLimit } from "./rate-limit";
import { fail } from "./api-response";
import { findApiOperation, parseApiResponse } from "@pstack/contracts/http";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Record<string, unknown>;
const sensitiveFieldPattern =
  /(password|token|secret|cookie|authorization|api[_-]?key|access[_-]?key|session|database.?url|redis.?url)/i;
const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string")
    return value
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
      .replace(
        /((?:password|token|secret|authorization|cookie)\s*[=:]\s*)[^\s&,;]+/gi,
        "$1[REDACTED]",
      );
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (value instanceof Error)
    return {
      name: value.name,
      message:
        env.NODE_ENV === "production"
          ? "Operation failed"
          : redact(value.message, seen),
    };
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveFieldPattern.test(key) ? "[REDACTED]" : redact(item, seen),
    ]),
  );
}
export function log(level: LogLevel, message: string, fields?: LogFields) {
  if (rank[level] < rank[env.LOG_LEVEL]) return;
  const line = JSON.stringify({
    level,
    message: redact(message),
    time: new Date().toISOString(),
    service: env.APP_NAME,
    fields: redact(fields || {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
export async function withAccessLog(
  request: Request,
  traceId: string,
  handler: () => Promise<Response>,
) {
  const startedAt = Date.now();
  const path = new URL(request.url).pathname;
  let response: Response;
  try {
    if (request.method === "POST" && path === "/api/telemetry")
      await assertRequestRateLimit("telemetry:global", {
        limit: 120,
        windowMs: 60000,
      });
    response = await handler();
    const operation = findApiOperation(request.method, path);
    if (operation) {
      const body = parseApiResponse(
        operation.operationId,
        response.status,
        await response.clone().json(),
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      response = Response.json(body, { status: response.status, headers });
    }
  } catch (error) {
    logger.error("http request failed", {
      traceId,
      method: request.method,
      path,
      error,
    });
    response = fail(error, traceId);
  }
  logger.info("http request", {
    traceId,
    method: request.method,
    path,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return response;
}
export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
