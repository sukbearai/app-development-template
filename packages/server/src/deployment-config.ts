import { isAbsolute } from "node:path";
import { readKafkaConfig } from "@pstack/kafka";
import { envSchema } from "./env-schema";

export type ConfigIssue = { key: string; code: string; message: string };

const placeholder =
  /^(?:local-development-only|changeme|change[-_]me|replace[-_]me(?:[-_].*)?|your[-_].*|password|secret|postgres|minioadmin|localadmin|example)$/i;

function isPlaceholder(value: string) {
  return placeholder.test(value.trim()) || /^<.*>$/.test(value.trim());
}

function readUrl(value: string, protocols: string[]) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

function checkUrlCredentials(url: URL, key: string, issues: ConfigIssue[]) {
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.pathname);
    if (url.password && isPlaceholder(decodeURIComponent(url.password)))
      issues.push({
        key,
        code: "PLACEHOLDER_CREDENTIAL",
        message: "Replace template credentials with provisioned credentials.",
      });
  } catch {
    issues.push({
      key,
      code: "INVALID_URL",
      message: "URL credentials must use valid percent encoding.",
    });
  }
}

function checkShutdown(raw: NodeJS.ProcessEnv, issues: ConfigIssue[]) {
  const multipliers = new Map([
    ["ms", 1],
    ["s", 1000],
    ["m", 60000],
    ["h", 3600000],
  ]);
  for (const [timeoutKey, graceKey] of [
    ["WEB_SHUTDOWN_TIMEOUT_MS", "WEB_STOP_GRACE_PERIOD"],
    ["WORKER_SHUTDOWN_TIMEOUT_MS", "WORKER_STOP_GRACE_PERIOD"],
  ]) {
    const drain = Number(raw[timeoutKey] ?? "30000");
    if (!Number.isInteger(drain) || drain < 1 || drain > 300000) {
      issues.push({
        key: timeoutKey,
        code: "INVALID_VALUE",
        message: "Use an integer from 1 through 300000 milliseconds.",
      });
      continue;
    }
    const value = raw[graceKey] || "40s";
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value);
    const grace = match ? Number(match[1]) * (multipliers.get(match[2] ?? "") ?? 0) : 0;
    if (!Number.isFinite(grace) || grace <= drain)
      issues.push({
        key: graceKey,
        code: "INSUFFICIENT_GRACE",
        message: `Use a duration with ms, s, m, or h that exceeds ${timeoutKey}.`,
      });
  }
}

function checkKafka(raw: NodeJS.ProcessEnv, issues: ConfigIssue[]) {
  for (const key of ["OUTBOX_PUBLISHER", "ASYNC_RUNTIME_PUBLISHER"]) {
    if (raw[key] !== undefined && !["disabled", "dry-run", "kafka"].includes(raw[key]))
      issues.push({ key, code: "INVALID_VALUE", message: "Use disabled, dry-run, or kafka." });
  }
  if (raw.OUTBOX_PUBLISHER !== "kafka" && raw.ASYNC_RUNTIME_PUBLISHER !== "kafka") return;
  try {
    readKafkaConfig(raw);
  } catch {
    issues.push({
      key: "KAFKA_BROKERS",
      code: "INVALID_KAFKA_CONFIG",
      message:
        "Selected Kafka configuration must pass the Kafka parser, including certificate files and SASL settings.",
    });
  }
  if (raw.KAFKA_SECURITY_PROTOCOL !== "SSL" && raw.KAFKA_SECURITY_PROTOCOL !== "SASL_SSL")
    issues.push({
      key: "KAFKA_SECURITY_PROTOCOL",
      code: "TLS_REQUIRED",
      message: "Use SSL or SASL_SSL for deployment Kafka connections.",
    });
  for (const key of ["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"]) {
    if (raw[key] && isPlaceholder(raw[key]))
      issues.push({
        key,
        code: "PLACEHOLDER_CREDENTIAL",
        message: "Replace template credentials with provisioned credentials.",
      });
  }
}

/** Static assessment only; Kafka may read configured certificate files. */
export function assessDeploymentConfig(raw: NodeJS.ProcessEnv): ConfigIssue[] {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      key: String(issue.path[0] ?? "environment"),
      code: "INVALID_VALUE",
      message: "Value does not satisfy the environment schema.",
    }));
  }
  const config = parsed.data;
  const issues: ConfigIssue[] = [];
  const required = (key: string) => {
    if (raw[key]?.trim()) return true;
    issues.push({ key, code: "REQUIRED", message: "Set this variable explicitly for deployment." });
    return false;
  };
  if (required("APP_ORIGIN") && !config.APP_ORIGIN?.startsWith("https://"))
    issues.push({
      key: "APP_ORIGIN",
      code: "HTTPS_REQUIRED",
      message: "Use the public HTTPS origin.",
    });
  const secure = raw.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (secure !== undefined && !["true", "1", "false", "0"].includes(secure))
    issues.push({
      key: "SESSION_COOKIE_SECURE",
      code: "INVALID_VALUE",
      message: "Use true, false, 1, or 0, or omit the override.",
    });
  if (secure === "false" || secure === "0")
    issues.push({
      key: "SESSION_COOKIE_SECURE",
      code: "SECURE_COOKIE_REQUIRED",
      message: "Deployment session cookies must be secure.",
    });

  if (required("DATABASE_URL")) {
    const url = readUrl(config.DATABASE_URL ?? "", ["postgres:", "postgresql:"]);
    if (
      !url ||
      url.pathname === "/" ||
      !url.pathname ||
      !url.username ||
      !url.password ||
      url.hash ||
      ["user", "password", "host", "port", "database", "dbname"].some((key) =>
        url.searchParams.has(key),
      )
    )
      issues.push({
        key: "DATABASE_URL",
        code: "INVALID_DATABASE_URL",
        message:
          "Use a PostgreSQL URL with host, database, username, and password, without fragments or query overrides for these fields.",
      });
    if (url) checkUrlCredentials(url, "DATABASE_URL", issues);
  }
  if (config.WEB_REPLICAS > 1 && config.RATE_LIMIT_DRIVER !== "redis")
    issues.push({
      key: "RATE_LIMIT_DRIVER",
      code: "SHARED_RATE_LIMIT_REQUIRED",
      message: "Multiple Web replicas require the Redis rate limit driver.",
    });
  if (config.RATE_LIMIT_DRIVER === "redis" && required("REDIS_URL")) {
    const url = readUrl(config.REDIS_URL ?? "", ["redis:", "rediss:"]);
    if (
      !url ||
      url.hash ||
      url.search ||
      (url.pathname !== "" && url.pathname !== "/" && !/^\/\d+$/.test(url.pathname))
    )
      issues.push({
        key: "REDIS_URL",
        code: "INVALID_URL",
        message:
          "Use a redis or rediss URL with a host and optional numeric database, without query or fragment.",
      });
    if (url) checkUrlCredentials(url, "REDIS_URL", issues);
  }

  if (required("METRICS_TOKEN") && isPlaceholder(raw.METRICS_TOKEN ?? ""))
    issues.push({
      key: "METRICS_TOKEN",
      code: "PLACEHOLDER_CREDENTIAL",
      message: "Generate a dedicated metrics credential.",
    });
  required("UPLOAD_STORAGE_DRIVER");
  if (config.UPLOAD_STORAGE_DRIVER === "local") {
    if (required("UPLOAD_STORAGE_DIR") && !isAbsolute(config.UPLOAD_STORAGE_DIR))
      issues.push({
        key: "UPLOAD_STORAGE_DIR",
        code: "ABSOLUTE_PATH_REQUIRED",
        message: "Use an absolute path backed by durable storage.",
      });
    if (config.WEB_REPLICAS > 1 && !config.UPLOAD_STORAGE_SHARED)
      issues.push({
        key: "UPLOAD_STORAGE_SHARED",
        code: "SHARED_STORAGE_REQUIRED",
        message:
          "Use S3 or explicitly attest that every replica mounts the same durable local storage.",
      });
  } else {
    for (const key of [
      "OBJECT_STORAGE_ENDPOINT",
      "OBJECT_STORAGE_ACCESS_KEY",
      "OBJECT_STORAGE_SECRET_KEY",
      "OBJECT_STORAGE_BUCKET",
    ])
      required(key);
    if (config.OBJECT_STORAGE_ENDPOINT) {
      const url = readUrl(config.OBJECT_STORAGE_ENDPOINT, ["https:"]);
      if (!url || url.username || url.password || url.search || url.hash)
        issues.push({
          key: "OBJECT_STORAGE_ENDPOINT",
          code: "INVALID_STORAGE_URL",
          message: "Use an HTTPS storage endpoint without credentials, query, or fragment.",
        });
    }
    for (const key of ["OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY"]) {
      if (raw[key] && isPlaceholder(raw[key]))
        issues.push({
          key,
          code: "PLACEHOLDER_CREDENTIAL",
          message: "Replace template credentials with provisioned credentials.",
        });
    }
  }
  checkKafka(raw, issues);
  checkShutdown(raw, issues);
  return issues;
}
