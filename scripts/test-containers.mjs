#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceIdentity } from "./verification-evidence.mjs";
import {
  containerOptions,
  prepareCandidateDirectory,
  writeContainerCandidate,
} from "./container-candidate.mjs";

const options = containerOptions(
  process.argv.slice(2),
  fileURLToPath(new URL("../", import.meta.url)),
);
const { root } = options;
if (options.output) await prepareCandidateDirectory(options.output);
const source = await sourceIdentity(root);
const { Client } = createRequire(path.join(root, "package.json"))("pg");
const id = randomBytes(8).toString("hex");
const prefix = `pstack-artifact-${id}`;
const images = { web: `${prefix}-web:local`, worker: `${prefix}-worker:local` };
const postgresImage = process.env.PSTACK_TEST_POSTGRES_IMAGE || "postgres:17-bullseye";
const kafkaImage = process.env.PSTACK_TEST_KAFKA_IMAGE || "bitnamilegacy/kafka:3.8.0";
const password = randomBytes(24).toString("base64url");
const adminPassword = randomBytes(24).toString("base64url");
const secrets = [password, adminPassword];
const outputRoot = path.join(root, ".verification", "containers");
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, "run-"));
const log = createWriteStream(path.join(output, "commands.log"), { mode: 0o600 });
const containers = new Map();
const builtImages = [];
const processes = new Set();
let networkCreated = false;
let interrupted = false;
const candidateAbort = new AbortController();
let database;
const summary = { source, output, postgresImage, kafkaImage, checks: [], status: "running" };
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (
    /^(DATABASE_|PG|E2E_|UI_FLOW_|APP_|SESSION_|RATE_LIMIT_|LOGIN_RATE_|REDIS_|KAFKA_|OUTBOX_|ASYNC_|UPLOAD_|OBJECT_STORAGE_|CLICKHOUSE_|BOOTSTRAP_)/.test(
      key,
    )
  )
    delete childEnv[key];
}
function redact(text) {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), String(text));
}
function command(program, commandArgs, { env = childEnv, capture = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error("Container verification interrupted");
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.add(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!capture) {
        const text = redact(chunk);
        log.write(text);
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = redact(chunk);
      log.write(text);
      if (!capture) process.stderr.write(text);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      processes.delete(child);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${program} ${commandArgs[0]} failed (${signal || code})`));
    });
  });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    candidateAbort.abort();
    process.exitCode = 1;
    for (const child of processes)
      try {
        process.kill(-child.pid, signal);
      } catch {}
  });
async function waitUntil(label, action, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Container verification interrupted");
    try {
      if (await action()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function container(role, image, env = {}, options = [], cmd = []) {
  const name = `${prefix}-${role}`;
  const containerId = await command(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      prefix,
      "--label",
      `pstack.artifact-test=${id}`,
      ...options,
      ...Object.keys(env).flatMap((key) => ["--env", key]),
      image,
      ...cmd,
    ],
    { env: { ...childEnv, ...env }, capture: true },
  );
  containers.set(role, containerId);
  return containerId;
}
async function finished(role, timeout = 90_000) {
  const containerId = containers.get(role);
  await waitUntil(
    role,
    async () => {
      const state = JSON.parse(
        await command("docker", ["inspect", "--format", "{{json .State}}", containerId], {
          capture: true,
        }),
      );
      if (state.Running) return false;
      assert.equal(state.ExitCode, 0, `${role} exited ${state.ExitCode}`);
      return true;
    },
    timeout,
  );
}
console.log(`Container evidence: ${output}`);
try {
  for (const target of ["web", "worker"]) {
    console.log(`Building Docker target ${target}`);
    await command("docker", ["build", "--target", target, "--tag", images[target], root]);
    builtImages.push(images[target]);
  }
  summary.images = Object.fromEntries(
    await Promise.all(
      Object.entries(images).map(async ([role, tag]) => [
        role,
        {
          tag,
          id: await command("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
            capture: true,
          }),
          platform: await command(
            "docker",
            ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", tag],
            { capture: true },
          ),
        },
      ]),
    ),
  );
  await command("docker", ["network", "create", "--label", `pstack.artifact-test=${id}`, prefix], {
    capture: true,
  });
  networkCreated = true;
  const postgres = await container(
    "postgres",
    postgresImage,
    { POSTGRES_USER: "app", POSTGRES_PASSWORD: password, POSTGRES_DB: "app" },
    [
      "--network-alias",
      "postgres",
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data",
    ],
  );
  const kafka = await container(
    "kafka",
    kafkaImage,
    {
      KAFKA_CFG_NODE_ID: "1",
      KAFKA_CFG_PROCESS_ROLES: "broker,controller",
      KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
      KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://kafka:9092",
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT",
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093",
      KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
      KAFKA_CFG_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
      KAFKA_CFG_TRANSACTION_STATE_LOG_MIN_ISR: "1",
      ALLOW_PLAINTEXT_LISTENER: "yes",
    },
    ["--network-alias", "kafka"],
  );
  await waitUntil("PostgreSQL", async () => {
    await command(
      "docker",
      ["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"],
      { capture: true },
    );
    return true;
  });
  await waitUntil("Kafka broker", async () => {
    await command(
      "docker",
      [
        "exec",
        kafka,
        "/opt/bitnami/kafka/bin/kafka-topics.sh",
        "--bootstrap-server",
        "kafka:9092",
        "--list",
      ],
      { capture: true },
    );
    return true;
  });
  const pgMapping = await command("docker", ["port", postgres, "5432/tcp"], { capture: true });
  const hostDatabaseUrl = `postgres://app:${password}@127.0.0.1:${pgMapping.split(":").at(-1)}/app`;
  database = new Client({ connectionString: hostDatabaseUrl });
  await database.connect();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const runtimeEnv = {
    NODE_ENV: "production",
    DATABASE_URL: `postgres://app:${password}@postgres:5432/app`,
    APP_NAME: "Artifact proof",
    APP_ORIGIN: origin,
    LOG_LEVEL: "warn",
    SESSION_COOKIE_SECURE: "false",
    RATE_LIMIT_DRIVER: "memory",
    LOGIN_RATE_LIMIT_MAX: "100",
    UPLOAD_STORAGE_DRIVER: "local",
    UPLOAD_STORAGE_DIR: "/app/uploads",
    UPLOAD_MAX_BYTES: "10485760",
    KAFKA_BROKERS: "kafka:9092",
    KAFKA_CLIENT_ID: prefix,
    KAFKA_CONSUMER_GROUP_ID: prefix,
    ASYNC_RUNTIME_TOPICS: "app.tasks,telemetry.events,files.events",
    OUTBOX_PUBLISHER: "kafka",
    OUTBOX_POLL_INTERVAL_MS: "200",
    WORKER_HEARTBEAT_PATH: "/tmp/pstack-worker-heartbeat.json",
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
  };
  await container(
    "migrate",
    images.web,
    runtimeEnv,
    [],
    ["pnpm", "--filter", "@pstack/database", "db:migrate"],
  );
  await finished("migrate");
  await container(
    "bootstrap",
    images.web,
    { ...runtimeEnv, BOOTSTRAP_ADMIN_ACCOUNT: "admin", BOOTSTRAP_ADMIN_PASSWORD: adminPassword },
    [],
    ["pnpm", "--filter", "@pstack/server", "admin:bootstrap"],
  );
  await finished("bootstrap");
  summary.checks.push("built Web image runs migration and administrator bootstrap");
  const web = await container("web", images.web, runtimeEnv, [
    "--init",
    "--publish",
    `127.0.0.1:${port}:3000`,
  ]);
  const worker = await container("worker", images.worker, runtimeEnv, ["--init"]);
  await waitUntil(
    "Web production readiness",
    async () =>
      (await fetch(`${origin}/api/system/health`, { signal: AbortSignal.timeout(3000) })).ok,
  );
  await waitUntil("worker live heartbeat", async () => {
    await command(
      "docker",
      [
        "exec",
        worker,
        "pnpm",
        "--filter",
        "@pstack/worker",
        "exec",
        "tsx",
        "src/index.ts",
        "health",
        "--live",
      ],
      { capture: true },
    );
    return true;
  });
  await command(process.execPath, [path.join(root, "apps/web/scripts/smoke.mjs")], {
    env: {
      ...childEnv,
      SMOKE_BASE_URL: origin,
      UI_FLOW_ADMIN_ACCOUNT: "admin",
      UI_FLOW_ADMIN_PASSWORD: adminPassword,
    },
  });
  summary.checks.push(
    "production Docker Web passes HTTP authentication, RBAC, upload, telemetry and health smoke",
  );
  const eventId = `artifact-${id}`;
  await database.query(
    "INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES($1,'app.tasks','demo.echo',$1,$2::jsonb)",
    [eventId, JSON.stringify({ marker: id })],
  );
  async function receipt() {
    return (
      await database.query(
        "SELECT count(*)::int AS n FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'=$1",
        [id],
      )
    ).rows[0].n;
  }
  await waitUntil("worker receipt", async () => {
    const row = (
      await database.query("SELECT status FROM app_outbox_events WHERE id=$1", [eventId])
    ).rows[0];
    return row.status === "published" && (await receipt()) === 1;
  });
  const generation = (
    await database.query("SELECT lease_generation FROM app_outbox_events WHERE id=$1", [eventId])
  ).rows[0].lease_generation;
  await database.query(
    "UPDATE app_outbox_events SET status='pending', next_attempt_at=now() WHERE id=$1",
    [eventId],
  );
  await waitUntil("duplicate publication", async () => {
    const row = (
      await database.query("SELECT status,lease_generation FROM app_outbox_events WHERE id=$1", [
        eventId,
      ])
    ).rows[0];
    return row.status === "published" && row.lease_generation > generation;
  });
  await waitUntil(
    "source event receipts",
    async () =>
      (
        await database.query(
          "SELECT count(*)::int AS n FROM app_async_receipts WHERE event_type IN ('telemetry.recorded','telemetry.created','file.uploaded','files.uploaded')",
        )
      ).rows[0].n >= 2,
  );
  await waitUntil("duplicate consumer offset committed", async () => {
    const offsets = await command(
      "docker",
      [
        "exec",
        kafka,
        "/opt/bitnami/kafka/bin/kafka-consumer-groups.sh",
        "--bootstrap-server",
        "kafka:9092",
        "--group",
        prefix,
        "--describe",
      ],
      { capture: true },
    );
    const rows = offsets
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[0] === prefix && fields[1] === "app.tasks");
    return (
      rows.length > 0 &&
      rows.every((fields) => Number(fields[3]) >= 2 && fields[3] === fields[4] && fields[5] === "0")
    );
  });
  assert.equal(await receipt(), 1);
  summary.checks.push(
    "built worker publishes via real Kafka, consumes Web events and persists one receipt after duplicate publication",
  );
  await command("docker", ["stop", "--time", "40", worker], { capture: true });
  const workerState = JSON.parse(
    await command("docker", ["inspect", "--format", "{{json .State}}", worker], { capture: true }),
  );
  assert.equal(workerState.ExitCode, 0);
  await command(
    "docker",
    [
      "cp",
      `${worker}:/tmp/pstack-worker-heartbeat.json`,
      path.join(output, "worker-heartbeat.json"),
    ],
    { capture: true },
  );
  assert.equal(
    JSON.parse(await readFile(path.join(output, "worker-heartbeat.json"), "utf8")).state,
    "stopped",
  );
  summary.checks.push("Docker SIGTERM drains worker and records stopped heartbeat with exit 0");
  await command("docker", ["stop", "--time", "40", web], { capture: true });
  const webState = JSON.parse(
    await command("docker", ["inspect", "--format", "{{json .State}}", web], { capture: true }),
  );
  assert.equal(webState.ExitCode, 0);
  summary.checks.push("Docker SIGTERM drains the built Web process with exit 0");
  summary.status = "passed";
  console.log("Container artifact integration passed");
} catch (error) {
  summary.status = "failed";
  summary.error = redact(error.message);
  process.exitCode = 1;
  console.error(summary.error);
} finally {
  if (database) await database.end().catch(() => {});
  const cleanupErrors = [];
  for (const [role, containerId] of [...containers].reverse()) {
    try {
      const logs = await command("docker", ["logs", containerId], { capture: true, cleanup: true });
      await writeFile(path.join(output, `${role}.log`), redact(logs), { mode: 0o600 });
    } catch (error) {
      cleanupErrors.push(`${role} logs: ${error.message}`);
    }
    try {
      await command("docker", ["rm", "--force", "--volumes", containerId], {
        capture: true,
        cleanup: true,
      });
    } catch (error) {
      cleanupErrors.push(`${role}: ${error.message}`);
    }
  }
  if (networkCreated)
    try {
      await command("docker", ["network", "rm", prefix], { capture: true, cleanup: true });
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  if (summary.status === "passed" && !interrupted && !cleanupErrors.length && options.output) {
    try {
      assert.deepEqual(
        await sourceIdentity(root),
        source,
        "Source changed during container verification",
      );
      for (const role of ["web", "worker"]) {
        assert.equal(
          await command("docker", ["image", "inspect", "--format", "{{.Id}}", images[role]], {
            capture: true,
            cleanup: true,
          }),
          summary.images[role].id,
          "Image changed after verification",
        );
        await command(
          "docker",
          [
            "image",
            "save",
            "--output",
            path.join(options.output, `${role}.tar`),
            summary.images[role].id,
          ],
          { capture: true, cleanup: true },
        );
      }
    } catch (error) {
      cleanupErrors.push(`candidate export: ${error.message}`);
    }
  }
  for (const tag of builtImages)
    try {
      await command("docker", ["image", "rm", tag], { capture: true, cleanup: true });
    } catch (error) {
      cleanupErrors.push(error.message);
    }
  if (cleanupErrors.length) {
    summary.cleanupErrors = cleanupErrors;
    summary.status = "failed";
    process.exitCode = 1;
  }
  if (interrupted) {
    summary.status = "failed";
    summary.error = "Container verification interrupted";
    process.exitCode = 130;
  }
  await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (summary.status === "passed" && !interrupted && options.output) {
    try {
      await writeContainerCandidate({
        root,
        output: options.output,
        source,
        summaryFile: path.join(output, "summary.json"),
        images: summary.images,
        signal: candidateAbort.signal,
      });
      console.log(`Candidate: ${path.join(options.output, "candidate.json")}`);
    } catch {
      summary.status = "failed";
      summary.error = "Candidate finalization failed";
      process.exitCode = interrupted ? 130 : 1;
      await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    }
  }
  await new Promise((resolve) => log.end(resolve));
}
