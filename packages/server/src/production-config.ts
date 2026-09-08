export { assessDeploymentConfig } from "./deployment-config";
export type { ConfigIssue } from "./deployment-config";
import { appOriginSchema } from "./config-values";

const requiredProductionEnvNames = ["DATABASE_URL", "APP_ORIGIN"] as const;

const storageEnvNames = [
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "OBJECT_STORAGE_BUCKET",
] as const;

function isProductionRuntime() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.APP_ENV === "production"
  );
}

export function validateProductionConfig() {
  if (!isProductionRuntime()) return [];

  const issues: string[] = [];
  for (const name of requiredProductionEnvNames) {
    const value = process.env[name]?.trim() || "";
    if (!value) {
      issues.push(`${name} is required`);
    }
  }
  if (process.env.APP_ORIGIN?.trim() && !appOriginSchema.safeParse(process.env.APP_ORIGIN).success)
    issues.push("APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment");

  if (Number(process.env.WEB_REPLICAS ?? "1") > 1 && process.env.RATE_LIMIT_DRIVER !== "redis")
    issues.push("RATE_LIMIT_DRIVER=redis is required when WEB_REPLICAS > 1");

  if (
    process.env.RATE_LIMIT_DRIVER === "redis" &&
    !process.env.REDIS_URL?.trim()
  ) {
    issues.push("REDIS_URL is required when RATE_LIMIT_DRIVER=redis");
  }

  if (process.env.UPLOAD_STORAGE_DRIVER === "s3") {
    for (const name of storageEnvNames) {
      if (!process.env[name]?.trim())
        issues.push(`${name} is required when UPLOAD_STORAGE_DRIVER=s3`);
    }
  }

  if (
    process.env.OUTBOX_PUBLISHER === "kafka" &&
    !process.env.KAFKA_BROKERS?.trim()
  ) {
    issues.push("KAFKA_BROKERS is required when OUTBOX_PUBLISHER=kafka");
  }

  return issues;
}
