import { loadWorkerEnv } from "./env";

type LogLevel = "debug" | "info" | "warn" | "error";
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Logging accepts arbitrary structured fields for recursive redaction.
type LogFields = Record<string, unknown>;

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveFieldPattern =
  /(password|token|secret|cookie|authorization|api[_-]?key|access[_-]?key|session)/i;

function logLevel(): LogLevel {
  return loadWorkerEnv({ allowMissingPublisher: true }).logLevel;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch values need not be Error instances; serialization preserves other values.
function normalizeError(error: unknown) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    stack: loadWorkerEnv({ allowMissingPublisher: true }).nodeEnv === "production" ? undefined : error.stack,
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Logging sanitizes arbitrary nested values before serialization.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only objects can contain fields needing recursive redaction.
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveFieldPattern.test(key) ? "[REDACTED]" : redact(item),
    ]),
  );
}

export function log(level: LogLevel, message: string, fields?: LogFields) {
  if (rank[level] < rank[logLevel()]) return;
  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    service: loadWorkerEnv({ allowMissingPublisher: true }).appName,
    ...Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [
      key, sensitiveFieldPattern.test(key) ? "[REDACTED]" : redact(value),
    ])),
    error:
      fields && "error" in fields ? normalizeError(fields.error) : undefined,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
