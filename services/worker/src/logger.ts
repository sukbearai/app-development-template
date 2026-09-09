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

const safeErrorMessages = [
  "Worker runtime failed",
  "Kafka consumer failed",
  "Kafka recovery initialization and cleanup failed",
  "Heartbeat write and cleanup failed",
  "Application restore is incomplete; worker startup is blocked",
  "Kafka recovery is incomplete; worker startup is blocked",
  "Kafka recovery history unavailable",
  "Kafka recovery transport offset missing or reset",
  "Kafka cluster identity is unavailable",
  "Kafka recovery topic is missing",
  "Kafka recovery requires cleanup.policy=delete",
  "Kafka partition offset is missing",
  "Kafka recovery cluster differs from the checkpoint",
  "Kafka recovery partition topology changed",
  "Kafka recovery transport offsets are incomplete",
  "Kafka recovery requires one transport consumer; group is unavailable or has multiple members",
  "Kafka recovery requires a fresh transport group",
  "Kafka recovery transport group already exists",
  "Kafka recovery transport has existing offsets",
  "Kafka recovery transport initialization readback differs",
  "Restored Kafka database requires its permanent recovery transport",
  "Kafka recovery logical group differs from worker configuration",
  "Invalid Kafka recovery transport binding",
  "Kafka recovery subscriptions differ from checkpoint",
  "Kafka recovery received an unexpected partition or rewound offset",
  "Kafka recovery committed an unknown partition",
];

function errorDiagnostics(error: Error) {
  const diagnostics: { path: string; message: string }[] = [];
  const seen = new Set<Error>([error]);
  let truncated = false;

  function visit(cause: unknown, path: string, depth: number) {
    if (depth > 4 || diagnostics.length >= 16) {
      truncated = true;
      return;
    }
    if (!(cause instanceof Error)) {
      diagnostics.push({ path, message: "Non-Error thrown value" });
      return;
    }
    if (seen.has(cause)) {
      diagnostics.push({ path, message: "Circular error reference" });
      return;
    }
    seen.add(cause);
    const rawMessage: unknown = Object.getOwnPropertyDescriptor(cause, "message")?.value;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Read only string data properties; nested error accessors must never run while logging.
    const message = typeof rawMessage === "string" ? rawMessage : "";
    diagnostics.push({
      path,
      message:
        safeErrorMessages.find((safe) => message === safe || message.startsWith(`${safe}:`)) ??
        "Error details omitted",
    });
    children(cause, path, depth);
  }

  function children(value: Error, path: string, depth: number) {
    const prefix = path ? `${path}.` : "";
    const errors: unknown =
      value instanceof AggregateError
        ? Object.getOwnPropertyDescriptor(value, "errors")?.value
        : undefined;
    if (Array.isArray(errors)) {
      const length: unknown = Object.getOwnPropertyDescriptor(errors, "length")?.value;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Array proxies can expose untrusted descriptors; iteration uses only a numeric length.
      if (typeof length === "number") {
        for (let index = 0; index < length; index++) {
          visit(
            Object.getOwnPropertyDescriptor(errors, index)?.value,
            `${prefix}errors[${index}]`,
            depth + 1,
          );
          if (diagnostics.length >= 16 || depth >= 4) {
            truncated ||= index + 1 < length;
            break;
          }
        }
      }
    }
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && "value" in cause) visit(cause.value, `${prefix}cause`, depth + 1);
  }

  try {
    children(error, "", 0);
  } catch {
    truncated = true;
  }

  if (truncated) diagnostics.push({ path: "", message: "Error diagnostics truncated" });
  return diagnostics.length ? diagnostics : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch values need not be Error instances; serialization preserves other values.
function normalizeError(error: unknown) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    diagnostics: errorDiagnostics(error),
    stack:
      loadWorkerEnv({ allowMissingPublisher: true }).nodeEnv === "production"
        ? undefined
        : error.stack,
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
    ...Object.fromEntries(
      Object.entries(fields || {})
        .filter(([key]) => key !== "error")
        .map(([key, value]) => [
          key,
          sensitiveFieldPattern.test(key) ? "[REDACTED]" : redact(value),
        ]),
    ),
    error: fields && "error" in fields ? normalizeError(fields.error) : undefined,
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
