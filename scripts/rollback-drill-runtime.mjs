import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { dockerCommand } from "./deployment-compose.mjs";
import { toolchain } from "./release-security.mjs";
import { createTestTrpcClient } from "./trpc-client.mjs";
import { rollbackChecks, migrationChecks } from "./rollback-proof.mjs";

import {
  imageMigrationHistoryCommand,
  liveSchemaCommand,
  verifyMigrationExecution,
} from "./migration-compatibility.mjs";
import { sha256 } from "./verification-evidence.mjs";

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
  const definition = {
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
      migrate: {
        ...app,
        environment: {
          ...environment,
          PGOPTIONS: "-c lock_timeout=1000 -c statement_timeout=120000",
        },
        command: ["pnpm", "--filter", "@pstack/database", "db:migrate"],
      },
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
  };
  for (const [role, release] of [
    ["web", previous],
    ["worker", previous],
    ["candidate-web", candidate],
    ["candidate-worker", candidate],
  ]) {
    const baseRole = role.endsWith("worker") ? "worker" : "web";
    definition.services[role] = {
      ...definition.services[baseRole],
      image: release.images[baseRole].reference,
      environment: { ...environment, WORKER_ID: `${project}-${role}` },
    };
  }
  await writeFile(composeFile, JSON.stringify(definition), { mode: 0o600 });
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
  async function round(release, marker, candidateRound = false, start = false) {
    const web = candidateRound ? "candidate-web" : "web";
    const worker = candidateRound ? "candidate-worker" : "worker";
    if (start) await compose(release, ["up", "--detach", "--no-deps", "--no-build", web, worker]);
    await waitFor(async () => {
      const ids = (await compose(release, ["ps", "--quiet", web, worker]))
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length !== 2) return false;
      const containers = JSON.parse(await docker(["inspect", ...ids]));
      return containers.every(
        (container) => container.State.Running && container.State.Health?.Status === "healthy",
      );
    });
    const mapping = await compose(release, ["port", web, "3000"]);
    const origin = `http://${mapping}`;

    const token = (
      await createTestTrpcClient({ baseUrl: origin }).auth.login.mutate({
        account: "admin",
        password,
      })
    ).token;
    const client = createTestTrpcClient({
      baseUrl: origin,
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 2000,
    });
    const existing = await client.roles.list.query();
    for (const role of roles)
      assert.ok(
        existing.some((entry) => entry.id === role),
        "Previous application role was lost",
      );
    for (const upload of uploads) {
      assert.equal(
        await compose(release, ["exec", "-T", web, "cat", `/app/uploads/${upload.storageKey}`]),
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
    return client;
  }
  try {
    report.stage = "infrastructure";
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
    const history = async (release) => {
      const integrity = JSON.parse(
        await compose(release, [
          "run",
          "--rm",
          "--no-deps",
          "migrate",
          ...imageMigrationHistoryCommand,
        ]),
      );
      return { ledgerSha256: sha256(integrity), integrity };
    };
    report.stage = "image_history";
    const previousHistory = await history(previous);
    const candidateHistory = await history(candidate);
    if (previous.compatibility)
      assert.equal(
        previousHistory.ledgerSha256,
        previous.compatibility.migrationLedgerSha256,
        "Predecessor image ledger mismatch",
      );
    const applied = async () =>
      JSON.parse(
        await sql(
          "SELECT coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at) ORDER BY created_at),'[]'::json) FROM drizzle.drizzle_migrations",
        ),
      );
    report.stage = "previous_migration";
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
    report.stage = "previous_application";
    const previousClient = await round(previous, "previous", false, true);
    report.checks.push(rollbackChecks[0]);
    const before = await applied();
    report.stage = "candidate_migration";
    const instances = async () => {
      const ids = (await compose(previous, ["ps", "--quiet", "web", "worker"]))
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(ids.length, 2, "PREVIOUS_APPLICATION_UNAVAILABLE");
      return JSON.parse(await docker(["inspect", ...ids]))
        .map((container) => {
          assert.ok(container.State.Running, "PREVIOUS_APPLICATION_UNAVAILABLE");
          return {
            id: container.Id,
            startedAt: container.State.StartedAt,
            restarts: container.RestartCount,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    const availability = {
      before: await instances(),
      after: [],
      successfulWrites: 0,
      failedWrites: 0,
      maxLatencyMs: 0,
      requestTimeoutMs: 2000,
    };
    let migrating = true;
    const migrationResult = compose(candidate, ["run", "--rm", "--no-deps", "migrate"])
      .then(
        () => null,
        (error) => error,
      )
      .finally(() => {
        migrating = false;
      });
    while (migrating) {
      const started = performance.now();
      const id = `rollback_live_${availability.successfulWrites + availability.failedWrites}`;
      try {
        await previousClient.roles.create.mutate({
          id,
          name: id,
          permissionIds: ["admin.read"],
          status: "active",
        });
        roles.push(id);
        availability.successfulWrites++;
      } catch {
        availability.failedWrites++;
      }
      availability.maxLatencyMs = Math.max(availability.maxLatencyMs, performance.now() - started);
      if (migrating) await setTimeout(100);
    }
    const migrationError = await migrationResult;
    if (migrationError) throw migrationError;
    availability.after = await instances();
    report.migration = {
      availability,
      previous: previousHistory,
      candidate: candidateHistory,
      before,
      after: await applied(),
      imageId: candidate.images.web.id,
      command: "pnpm --filter @pstack/database db:migrate",
      exitCode: 0,
    };
    report.stage = "migration_availability";
    verifyMigrationExecution(report.migration);
    await compose(candidate, [
      "run",
      "--rm",
      "--no-deps",
      "migrate",
      ...liveSchemaCommand(report.migration.candidate.ledgerSha256),
    ]);
    report.checks.push(migrationChecks[0], migrationChecks[3]);
    report.stage = "previous_application_after_migration";
    await round(previous, "previous_migrated");
    report.checks.push(migrationChecks[1]);
    report.stage = "mixed_applications";
    await round(candidate, "candidate", true, true);
    report.checks.push(rollbackChecks[1]);
    await round(previous, "previous_mixed");
    await round(candidate, "candidate_mixed", true);
    report.checks.push(migrationChecks[2]);
    report.stage = "worker_recovery";
    const mixedMarker = randomBytes(12).toString("hex");
    await sql(
      `INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES('${mixedMarker}','app.tasks','demo.echo','${mixedMarker}','{"marker":"${mixedMarker}"}'::jsonb)`,
    );
    await waitFor(
      async () =>
        (await sql(
          `SELECT count(*) FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'='${mixedMarker}'`,
        )) === "1",
    );
    await compose(previous, ["stop", "web", "worker"]);
    const marker = randomBytes(12).toString("hex");
    await sql(
      `INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES('${marker}','app.tasks','demo.echo','${marker}','{"marker":"${marker}"}'::jsonb)`,
    );
    const count = () =>
      sql(
        `SELECT count(*) FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'='${marker}'`,
      );
    await waitFor(async () => (await count()) === "1");
    report.checks.push(migrationChecks[4]);
    const generation = await sql(
      `SELECT lease_generation FROM app_outbox_events WHERE id='${marker}'`,
    );
    await compose(candidate, ["stop", "candidate-web", "candidate-worker"]);
    await sql(
      `UPDATE app_outbox_events SET status='pending',next_attempt_at=now() WHERE id='${marker}'`,
    );
    await round(previous, "restored", false, true);
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
    assert.deepEqual(
      await applied(),
      report.migration.after,
      "Rollback changed database migration history",
    );
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
