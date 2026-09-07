import { env } from "./env";
import { assertRequestRateLimit } from "./rate-limit";
import { fail } from "./api-response";
import { findApiOperation, parseApiResponse } from "@pstack/contracts/http";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

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
const systemErrorCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM",
  "ENOENT", "ENOSPC", "EMFILE", "ENFILE", "EROFS", "EIO",
]);
const sqlStateCodes = new Set([
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "22001", "22003", "22007", "22P02", "23502", "23503", "23505", "23514",
  "23P01", "28000", "28P01", "3D000", "40001", "40P01", "42501", "42703",
  "42P01", "53100", "53200", "53300", "53400", "54000", "55P03", "57014",
  "57P01", "57P02", "57P03", "58000", "XX000", "XX001", "XX002",
]);
const sourceRoots = [fileURLToPath(new URL("../../../", import.meta.url)), resolve() + sep];
function errorDiagnostic(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = { message: "Operation failed" };
  try {
    if (!(value instanceof Error)) return diagnostic;
    if (seen.has(value)) return { message: "[CIRCULAR]" };
    seen.add(value);
    const code: unknown = Object.getOwnPropertyDescriptor(value, "code")?.value;
    if (typeof code === "string" &&
        (systemErrorCodes.has(code) || sqlStateCodes.has(code)))
      diagnostic.code = code;
    let stack: unknown;
    try {
      stack = value.stack;
    } catch {
      // V8 computes stack lazily and may invoke an error's throwing getters.
    }
    if (typeof stack === "string") {
      diagnostic.frames = stack.slice(0, 16384).split("\n").slice(1, 33).flatMap((line) => {
        const match = /^\s+at (?:[^()]* \()?((?:file:\/\/\/|\/|node:)[^()\s]+):(\d{1,7}):(\d{1,7})\)?$/.exec(line);
        if (!match?.[1]) return [];
        const source = match[1].replace(/^file:\/\//, "");
        if (!/^(?:node:)?[A-Za-z0-9_./@+-]+$/.test(source) || source.split("/").includes(".."))
          return [];
        const file = source.startsWith("node:internal/") ? source :
          sourceRoots.flatMap(root => source.startsWith(root) ? [source.slice(root.length)] : [])
            .find(candidate => /^(apps|packages|services|node_modules|dist)\/.+\.[cm]?[jt]sx?$/.test(candidate));
        if (!file || file.length > 240 ||
            (!file.startsWith("node:internal/") && !/^(apps|packages|services|node_modules|dist)\/.+\.[cm]?[jt]sx?$/.test(file)))
          return [];
        return [{ file, line: Number(match[2]), column: Number(match[3]) }];
      }).slice(0, 8);
    }
    const cause: unknown = Object.getOwnPropertyDescriptor(value, "cause")?.value;
    if (depth < 2 && cause instanceof Error)
      diagnostic.cause = errorDiagnostic(cause, seen, depth + 1);
  } catch {}
  return diagnostic;
}
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
    return env.NODE_ENV === "production" ? errorDiagnostic(value) : {
      name: value.name,
      message: redact(value.message, seen),
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
  let failure: { error: unknown } | undefined;
  try {
    if (request.method === "POST" && path === "/api/telemetry")
      await assertRequestRateLimit("telemetry:global", {
        limit: 120,
        windowMs: 60000,
      });
    response = await handler();
  } catch (error) {
    failure = { error };
    response = fail(error, traceId);
  }
  try {
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
    failure ??= { error };
    response = fail(error, traceId);
  }
  if (failure) {
    log(response.status >= 500 ? "error" : "warn", "http request failed", {
      traceId,
      method: request.method,
      path,
      error: errorDiagnostic(failure.error),
    });
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
