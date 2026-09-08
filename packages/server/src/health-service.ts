import { checkInfrastructure } from "./infrastructure";
import { validateProductionConfig } from "./production-config";

type HealthSnapshot = Awaited<ReturnType<typeof probeHealth>>;
let completed: { snapshot: HealthSnapshot; expiresAt: number } | undefined;
let inFlight: Promise<HealthSnapshot> | undefined;

export async function healthCheck() {
  if (completed && performance.now() < completed.expiresAt)
    return completed.snapshot;
  inFlight ??= probeHealth()
    .then((snapshot) => {
      completed = { snapshot, expiresAt: performance.now() + 1000 };
      return snapshot;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function probeHealth() {
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
