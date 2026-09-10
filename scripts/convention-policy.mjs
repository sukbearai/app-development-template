export const moduleEntrypoints = {
  contracts: ["contracts.ts"],
  database: ["repository.ts"],
  server: ["service.ts", "router.ts"],
  worker: ["handler.ts"],
};

export const platformFiles = {
  contracts: [
    "primitives.ts",
    "async-contracts.ts",
    "transport.ts",
    "http.ts",
    "openapi.ts",
    "index.ts",
    "outbox-health.ts",
    "runtime-metrics.ts",
  ],
  database: [
    "client.ts",
    "environment.ts",
    "index.ts",
    "schema.ts",
    "schema-check.ts",
    "process-lifecycle.ts",
    "operational-metrics.ts",
    "row-values.ts",
    "retention.ts",
  ],
  server: [
    "api-response.ts",
    "api-security.ts",
    "bootstrap-admin.ts",
    "config-values.ts",
    "deployment-config.ts",
    "env-schema.ts",
    "env.ts",
    "health-service.ts",
    "http-metrics.ts",
    "infrastructure.ts",
    "logger.ts",
    "metrics-auth.ts",
    "production-config.ts",
    "rate-limit.ts",
    "recover-admin.ts",
    "redis-client.ts",
    "request-auth.ts",
    "s3-client.ts",
    "storage.ts",
    "tracing-provider.ts",
    "tracing.ts",
    "trpc-handler.ts",
    "trpc-metrics.ts",
    "trpc.ts",
    "trpc-router.ts",
    "validation.ts",
    "index.ts",
    "password.ts",
    "event-service.ts",
    "upload-admission.ts",
    "upload-memory-limits.ts",
    "runtime-metrics.ts",
    "runtime-health-config.ts",
  ],
  worker: [
    "async-consumer.ts",
    "async-task.ts",
    "async-task-store.ts",
    "env.ts",
    "index.ts",
    "outbox-readiness.ts",
    "domain-handler.ts",
    "logger.ts",
    "cli-utils.ts",
    "async-runtime.ts",
    "worker-identity.ts",
    "heartbeat.ts",
    "kafka-recovery.ts",
    "outbox.ts",
  ],
};

export function moduleIdentity(relative) {
  const match =
    /^(packages\/(contracts|database|server)|services\/(worker))\/src\/modules\/([^/]+)\/(.+)$/.exec(
      relative,
    );
  if (!match) return undefined;
  return { workspace: match[1], layer: match[2] || match[3], domain: match[4], file: match[5] };
}

export function sameModule(left, right) {
  return Boolean(
    left && right && left.workspace === right.workspace && left.domain === right.domain,
  );
}

export function publicEntrypoint(module) {
  return moduleEntrypoints[module.layer]?.includes(module.file);
}
