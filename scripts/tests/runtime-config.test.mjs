import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const { buildRuntimePlanFromEnv } = await tsImport(
  "../../packages/server/src/runtime-health-config.ts",
  import.meta.url,
);
const { buildAsyncRuntimePlan } = await tsImport(
  "../../services/worker/src/async-runtime.ts",
  import.meta.url,
);

test("administrative plan uses worker defaults without claiming an unconfigured publisher", () => {
  assert.deepEqual(buildRuntimePlanFromEnv({}).topics, buildAsyncRuntimePlan([], {}).topics);
  assert.equal(buildRuntimePlanFromEnv({}).publisher, "unknown");
  assert.equal(buildRuntimePlanFromEnv({ OUTBOX_PUBLISHER: "dry-run" }).publisher, "dry-run");
});

test("Compose diagnostics match worker configuration without enabling Kafka readiness on Web", () => {
  const source = execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.example",
      "-f",
      "deploy/compose/docker-compose.yml",
      "--profile",
      "*",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSE_DATABASE_URL: "postgres://test:test@postgres/test",
        ASYNC_RUNTIME_TOPICS: "app.tasks,custom.events",
      },
    },
  );
  const { web, worker } = JSON.parse(source).services;
  const plan = buildRuntimePlanFromEnv(web.environment);
  const actual = buildAsyncRuntimePlan([], worker.environment);
  assert.equal(plan.publisher, "kafka");
  assert.equal(plan.publisher, actual.publisher);
  assert.deepEqual(plan.topics, ["app.tasks", "custom.events"]);
  assert.deepEqual(plan.topics, actual.topics);
  assert.equal(web.environment.OUTBOX_PUBLISHER, undefined);
});
