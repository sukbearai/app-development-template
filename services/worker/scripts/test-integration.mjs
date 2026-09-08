import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Kafka, logLevel } from "kafkajs";

const runId = randomUUID();
const ownerLabel = "dev.pstack.worker-integration";
const postgresImage = "postgres:17-bullseye";
const kafkaImage = "bitnamilegacy/kafka:3.8.0";
const password = randomBytes(24).toString("hex");
const names = {
  postgres: `pstack-worker-pg-${runId}`,
  kafka: `pstack-worker-kafka-${runId}`,
};
const startedAt = new Date().toISOString();
const evidence = {
  runId,
  startedAt,
  images: { postgres: postgresImage, kafka: kafkaImage },
  containers: names,
};
const ownedNames = [];
let testChild;
let interrupted;
let terminationError;

const redact = (value) => String(value).replaceAll(password, "[REDACTED]");
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function checkInterrupted() {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
}
function stopTest(signal = "SIGTERM") {
  if (!testChild) return;
  try {
    if (process.platform === "win32") testChild.kill(signal);
    else process.kill(-testChild.pid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    // macOS can return EPERM for a group that disappeared after child exit.
    if (
      error.code === "EPERM" &&
      (testChild.exitCode !== null || testChild.signalCode !== null)
    )
      return;
    terminationError = `Unable to terminate test process group: ${error.message}`;
    testChild.kill(signal);
  }
}
function onSignal(signal) {
  interrupted ??= signal;
  stopTest();
}
const onTerm = () => onSignal("SIGTERM"),
  onInt = () => onSignal("SIGINT");
process.on("SIGTERM", onTerm);
process.on("SIGINT", onInt);

function command(
  executable,
  args,
  { env = process.env, timeoutMs = 30000, stream = false, test = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: test && process.platform !== "win32",
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    });
    if (test) testChild = child;
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (test) stopTest("SIGKILL");
      else child.kill("SIGKILL");
    }, timeoutMs);
    let escalation;
    const poll = test
      ? setInterval(() => {
          if (interrupted && !escalation)
            escalation = setTimeout(() => stopTest("SIGKILL"), 5000);
        }, 100)
      : undefined;
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stream) process.stdout.write(redact(data));
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stream) process.stderr.write(redact(data));
    });
    function clear() {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (escalation) clearTimeout(escalation);
    }
    child.once("error", (error) => {
      clear();
      reject(error);
    });
    child.once("close", (code, signal) => {
      clear();
      if (test) {
        // Reap descendants even if the test runner exited before its runtime children.
        if (process.platform !== "win32") stopTest("SIGKILL");
        testChild = undefined;
      }
      if (code === 0 && !timedOut) resolve(stdout.trim());
      else
        reject(
          new Error(
            redact(
              `${executable} ${args[0]} failed (${timedOut ? "timeout" : (signal ?? code)}): ${stderr || stdout}`,
            ),
          ),
        );
    });
  });
}
const docker = (...args) => command("docker", args);
async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node may return a Unix address; only a TCP address has the allocated Kafka port.
  if (!address || typeof address === "string")
    throw new Error("Unable to allocate Kafka port");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function inspectOwned(name) {
  const label = await docker(
    "inspect",
    "--format",
    `{{index .Config.Labels "${ownerLabel}"}}`,
    name,
  );
  if (label !== runId)
    throw new Error(`Container ownership does not match this run: ${name}`);
}
async function waitReady(description, action, deadlineMs = 120000) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    checkInterrupted();
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
    }
    await pause(500);
  }
  throw new Error(
    `${description} readiness timed out: ${redact(lastError?.message)}`,
  );
}
async function cleanup() {
  const failures = [];
  for (const name of ownedNames.reverse()) {
    try {
      // Exact name plus random ownership label prevents cleanup of another run.
      const exists = await docker("ps", "-aq", "--filter", `name=^/${name}$`);
      if (!exists) continue;
      await inspectOwned(name);
      await docker("rm", "-f", "-v", name);
    } catch (error) {
      failures.push(redact(error.message));
    }
  }
  return failures;
}

let failure;
try {
  await docker("info", "--format", "{{.ServerVersion}}");
  checkInterrupted();
  ownedNames.push(names.postgres);
  await command(
    "docker",
    [
      "run",
      "-d",
      "--name",
      names.postgres,
      "--label",
      `${ownerLabel}=${runId}`,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=worker_integration",
      "-p",
      "127.0.0.1:0:5432",
      postgresImage,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, timeoutMs: 120000 },
  );
  await inspectOwned(names.postgres);
  const mapping = await docker("port", names.postgres, "5432/tcp");
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
  if (!match)
    throw new Error(
      "PostgreSQL container port is not bound exclusively to loopback",
    );
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${match[1]}/worker_integration`;
  await waitReady("PostgreSQL SELECT", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
    });
    try {
      await pool.query("SELECT 1");
    } finally {
      await pool.end();
    }
  });
  const kafkaPort = await reservePort();
  checkInterrupted();
  ownedNames.push(names.kafka);
  await command(
    "docker",
    [
      "run",
      "-d",
      "--name",
      names.kafka,
      "--label",
      `${ownerLabel}=${runId}`,
      "-p",
      `127.0.0.1:${kafkaPort}:9092`,
      "-e",
      "KAFKA_ENABLE_KRAFT=yes",
      "-e",
      "KAFKA_CFG_NODE_ID=1",
      "-e",
      "KAFKA_CFG_PROCESS_ROLES=broker,controller",
      "-e",
      "KAFKA_CFG_CONTROLLER_QUORUM_VOTERS=1@localhost:9093",
      "-e",
      "KAFKA_CFG_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093",
      "-e",
      `KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://127.0.0.1:${kafkaPort}`,
      "-e",
      "KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT",
      "-e",
      "KAFKA_CFG_CONTROLLER_LISTENER_NAMES=CONTROLLER",
      "-e",
      "ALLOW_PLAINTEXT_LISTENER=yes",
      "-e",
      "KAFKA_CFG_OFFSETS_TOPIC_REPLICATION_FACTOR=1",
      kafkaImage,
    ],
    { timeoutMs: 120000 },
  );
  await inspectOwned(names.kafka);
  const brokers = `127.0.0.1:${kafkaPort}`;
  await waitReady("Kafka metadata", async () => {
    const admin = new Kafka({
      clientId: `worker-ready-${runId}`,
      brokers: [brokers],
      connectionTimeout: 2000,
      requestTimeout: 2000,
      retry: { retries: 0 },
      logLevel: logLevel.NOTHING,
    }).admin();
    try {
      await admin.connect();
      const cluster = await admin.describeCluster();
      if (
        !cluster.brokers.some(
          (broker) => broker.host === "127.0.0.1" && broker.port === kafkaPort,
        )
      )
        throw new Error("Kafka advertises an unexpected broker");
    } finally {
      await admin.disconnect();
    }
  });
  evidence.imageIds = {
    postgres: await docker("inspect", "--format", "{{.Image}}", names.postgres),
    kafka: await docker("inspect", "--format", "{{.Image}}", names.kafka),
  };
  evidence.ports = { postgres: Number(match[1]), kafka: kafkaPort };
  report({ ...evidence, status: "ready" });
  checkInterrupted();
  const env = {
    ...process.env,
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
    WORKER_TEST_DATABASE_URL: databaseUrl,
    WORKER_TEST_KAFKA_BROKERS: brokers,
  };
  // A caller's unrelated migration directory must not change the self-contained check.
  env.WORKER_TEST_MIGRATIONS = fileURLToPath(
    new URL(
      "../migrations/template/",
      import.meta.resolve("@pstack/database/client"),
    ),
  );
  await command(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--test",
      "tests/integration.test.mjs",
    ],
    { env, stream: true, test: true, timeoutMs: 180000 },
  );
  checkInterrupted();
} catch (error) {
  failure = redact(error.message);
  process.stderr.write(`${failure}\n`);
} finally {
  const cleanupFailures = await cleanup();
  if (terminationError) cleanupFailures.push(terminationError);
  process.removeListener("SIGTERM", onTerm);
  process.removeListener("SIGINT", onInt);
  report({
    ...evidence,
    completedAt: new Date().toISOString(),
    status: failure || cleanupFailures.length ? "failed" : "passed",
    failure,
    cleanupFailures,
  });
  process.exitCode =
    interrupted === "SIGINT"
      ? 130
      : interrupted === "SIGTERM"
        ? 143
        : failure || cleanupFailures.length
          ? 1
          : 0;
}
