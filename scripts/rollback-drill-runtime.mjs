import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { composeTarget, dockerCommand } from "./deployment-compose.mjs";
import { toolchain } from "./release-security.mjs";
import { createTestTrpcClient } from "./trpc-client.mjs";
import { rollbackChecks } from "./rollback-proof.mjs";

async function waitFor(operation) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      if (await operation()) return;
    } catch {
      /* Startup and recovery share a bounded deadline. */
    }
    await setTimeout(1000);
  }
  throw new Error("ROLLBACK_DRILL_TIMEOUT");
}
export async function runRollbackDrill(previous, candidate, context, report) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pstack-rollback-")));
  const project = `pstack-rollback-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  const docker = (args) => dockerCommand(["--context", context, ...args], process.env);
  const [contextInfo] = JSON.parse(await docker(["context", "inspect", context]));
  assert.ok(
    contextInfo.Endpoints.docker.Host.startsWith("unix:///"),
    "Rollback drill requires a local Docker context",
  );
  const composeFile = path.join(directory, "compose.json");
  const environment = {
    NODE_ENV: "production",
    DATABASE_URL: `postgres://app:${password}@postgres:5432/app`,
    APP_NAME: "Rollback drill",
    APP_ORIGIN: "http://127.0.0.1",
    SESSION_COOKIE_SECURE: "false",
    LOG_LEVEL: "warn",
    RATE_LIMIT_DRIVER: "memory",
    LOGIN_RATE_LIMIT_MAX: "100",
    UPLOAD_STORAGE_DRIVER: "local",
    UPLOAD_STORAGE_DIR: "/app/uploads",
    UPLOAD_MAX_BYTES: "10485760",
    KAFKA_BROKERS: "kafka:9092",
    KAFKA_CLIENT_ID: project,
    KAFKA_CONSUMER_GROUP_ID: project,
    ASYNC_RUNTIME_TOPICS: "app.tasks,telemetry.events,files.events,audit.events",
    OUTBOX_PUBLISHER: "kafka",
    OUTBOX_POLL_INTERVAL_MS: "200",
    WORKER_HEARTBEAT_PATH: "/tmp/pstack-worker-heartbeat.json",
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
    BOOTSTRAP_ADMIN_ACCOUNT: "admin",
    BOOTSTRAP_ADMIN_PASSWORD: password,
  };
  const app = {
    image: "${PSTACK_WEB_IMAGE}",
    environment,
    init: true,
    volumes: ["uploads:/app/uploads"],
  };
  await writeFile(
    composeFile,
    JSON.stringify({
      services: {
        postgres: {
          image: toolchain.images.postgres,
          environment: { POSTGRES_USER: "app", POSTGRES_PASSWORD: password, POSTGRES_DB: "app" },
          volumes: ["database:/var/lib/postgresql/data"],
        },
        kafka: {
          image: toolchain.images.kafka,
          environment: {
            KAFKA_NODE_ID: "1",
            KAFKA_PROCESS_ROLES: "broker,controller",
            KAFKA_LISTENERS: "INTERNAL://:9092,CONTROLLER://:9093",
            KAFKA_ADVERTISED_LISTENERS: "INTERNAL://kafka:9092",
            KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT",
            KAFKA_INTER_BROKER_LISTENER_NAME: "INTERNAL",
            KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
            KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093",
            KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
            KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
            KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
            KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
          },
        },
        migrate: { ...app, command: ["pnpm", "--filter", "@pstack/database", "db:migrate"] },
        web: {
          ...app,
          ports: ["127.0.0.1::3000"],
          healthcheck: {
            test: [
              "CMD",
              "node",
              "-e",
              "fetch('http://127.0.0.1:3000/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
            ],
            interval: "2s",
            timeout: "5s",
            retries: 60,
          },
        },
        worker: {
          ...app,
          image: "${PSTACK_WORKER_IMAGE}",
          healthcheck: {
            test: [
              "CMD",
              "pnpm",
              "--filter",
              "@pstack/worker",
              "exec",
              "tsx",
              "src/index.ts",
              "health",
              "--live",
            ],
            interval: "3s",
            timeout: "10s",
            retries: 40,
          },
        },
      },
      volumes: { database: {}, uploads: {} },
    }),
    { mode: 0o600 },
  );
  const envFile = path.join(directory, ".env");
  await writeFile(envFile, "", { mode: 0o600 });
  const compose = (release, args) =>
    dockerCommand(
      ["--context", context, "compose", "--project-name", project, "-f", composeFile, ...args],
      {
        ...process.env,
        PSTACK_WEB_IMAGE: release.images.web.reference,
        PSTACK_WORKER_IMAGE: release.images.worker.reference,
      },
    );
  const target = {
    schemaVersion: 1,
    id: project,
    project,
    context,
    endpoint: contextInfo.Endpoints.docker.Host,
    repository: "fixture/rollback",
    composeFiles: [composeFile],
    envFile,
    stateDirectory: path.join(directory, "state"),
    services: ["web", "worker"],
    platform: previous.images.web.platform,
    readinessUrl: "http://127.0.0.1",
    timeoutSeconds: 180,
  };
  const roles = [];
  const uploads = [];
  const sql = (query) =>
    compose(previous, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "app",
      "-d",
      "app",
      "-At",
      "-c",
      query,
    ]);
  async function round(release, marker) {
    await compose(release, ["up", "--detach", "--no-deps", "--no-build", "web", "worker"]);
    const mapping = await compose(release, ["port", "web", "3000"]);
    const origin = `http://${mapping}`;
    target.readinessUrl = `${origin}/api/system/health`;
    await composeTarget(target).ready(release);
    const token = (
      await createTestTrpcClient({ baseUrl: origin }).auth.login.mutate({
        account: "admin",
        password,
      })
    ).token;
    const client = createTestTrpcClient({
      baseUrl: origin,
      headers: { authorization: `Bearer ${token}` },
    });
    const existing = await client.roles.list.query();
    for (const role of roles)
      assert.ok(
        existing.some((entry) => entry.id === role),
        "Previous application role was lost",
      );
    for (const upload of uploads) {
      assert.equal(
        await compose(release, ["exec", "-T", "web", "cat", `/app/uploads/${upload.storageKey}`]),
        upload.content,
      );
    }
    const roleId = `rollback_${marker}`;
    await client.roles.create.mutate({
      id: roleId,
      name: `Rollback ${marker}`,
      permissionIds: ["admin.read"],
      status: "active",
    });
    roles.push(roleId);
    const content = `persisted-${marker}`;
    const form = new FormData();
    form.set("file", new File([content], `${marker}.txt`, { type: "text/plain" }));
    const response = await fetch(`${origin}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, "Rollback upload failed");
    uploads.push({ storageKey: (await response.json()).data.storageKey, content });
  }
  try {
    await compose(previous, ["up", "--detach", "postgres", "kafka"]);
    await waitFor(async () => (await sql("SELECT 1")) === "1");
    await waitFor(async () => {
      await compose(previous, [
        "exec",
        "-T",
        "kafka",
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server",
        "kafka:9092",
        "--list",
      ]);
      return true;
    });
    await compose(previous, ["run", "--rm", "--no-deps", "migrate"]);
    await compose(previous, [
      "run",
      "--rm",
      "--no-deps",
      "migrate",
      "pnpm",
      "--filter",
      "@pstack/server",
      "admin:bootstrap",
    ]);
    await round(previous, "previous");
    report.checks.push(rollbackChecks[0]);
    await compose(previous, ["stop", "web", "worker"]);
    await round(candidate, "candidate");
    report.checks.push(rollbackChecks[1]);
    const marker = randomBytes(12).toString("hex");
    await sql(
      `INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES('${marker}','app.tasks','demo.echo','${marker}','{"marker":"${marker}"}'::jsonb)`,
    );
    const count = () =>
      sql(
        `SELECT count(*) FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'='${marker}'`,
      );
    await waitFor(async () => (await count()) === "1");
    const generation = await sql(
      `SELECT lease_generation FROM app_outbox_events WHERE id='${marker}'`,
    );
    await compose(candidate, ["stop", "web", "worker"]);
    await sql(
      `UPDATE app_outbox_events SET status='pending',next_attempt_at=now() WHERE id='${marker}'`,
    );
    await round(previous, "restored");
    report.checks.push(rollbackChecks[2]);
    await waitFor(
      async () =>
        (await sql(
          `SELECT (status='published' AND lease_generation>${Number(generation)})::int FROM app_outbox_events WHERE id='${marker}'`,
        )) === "1",
    );
    await waitFor(async () => {
      const offsets = await compose(previous, [
        "exec",
        "-T",
        "kafka",
        "/opt/kafka/bin/kafka-consumer-groups.sh",
        "--bootstrap-server",
        "kafka:9092",
        "--group",
        project,
        "--describe",
      ]);
      const rows = offsets
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields[0] === project && fields[1] === "app.tasks");
      return (
        rows.length > 0 &&
        rows.every(
          (fields) => Number(fields[3]) >= 2 && fields[3] === fields[4] && fields[5] === "0",
        )
      );
    });
    assert.equal(await count(), "1");
    report.checks.push(rollbackChecks[3]);
    report.status = "passed";
  } finally {
    for (const [kind, list, remove] of [
      ["container", ["ps", "-aq"], ["rm", "--force"]],
      ["volume", ["volume", "ls", "-q"], ["volume", "rm"]],
      ["network", ["network", "ls", "-q"], ["network", "rm"]],
    ]) {
      try {
        const ids = (
          await docker([...list, "--filter", `label=com.docker.compose.project=${project}`])
        )
          .split(/\s+/)
          .filter(Boolean);
        if (ids.length) await docker([...remove, ...ids]);
      } catch {
        report.cleanupErrors.push(`Failed to remove drill ${kind}`);
      }
    }
    await rm(directory, { recursive: true, force: true });
    if (report.cleanupErrors.length) report.status = "failed";
  }
}
