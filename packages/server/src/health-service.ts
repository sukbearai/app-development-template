import { checkInfrastructure } from "./infrastructure";
import { validateProductionConfig } from "./production-config";

export async function healthCheck() {
  const infrastructure = await checkInfrastructure();
  const configIssues = validateProductionConfig();
  const dependencies = {
    database: infrastructure.database,
    redis: infrastructure.redis,
    objectStorage: infrastructure.objectStorage,
    kafka: infrastructure.kafka,
    config: configIssues.length ? "error" : "ok",
  };
  const status = Object.values(dependencies).some(
    (state) => state === "error" || state === "missing",
  )
    ? "degraded"
    : "ok";

  return {
    status,
    service: "web",
    time: new Date().toISOString(),
    dependencies,
    configIssues,
  };
}
