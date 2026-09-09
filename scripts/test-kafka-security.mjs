#!/usr/bin/env node
import { verificationDirectory } from "./verification-output.mjs";
import { sourceIdentity } from "./verification-evidence.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const { Kafka, logLevel } = createRequire(path.join(root, "services/worker/package.json"))(
  "kafkajs",
);

async function probe(mode) {
  if (mode === "control") {
    const kafka = new Kafka({
      clientId: "security-control",
      brokers: process.env.KAFKA_BROKERS.split(","),
      ssl: { ca: [await readFile(process.env.KAFKA_SSL_CA_FILE, "utf8")] },
      sasl: {
        mechanism: "plain",
        username: process.env.KAFKA_SASL_USERNAME,
        password: process.env.KAFKA_SASL_PASSWORD,
      },
      connectionTimeout: 1500,
      requestTimeout: 2000,
      retry: { retries: 0 },
      logLevel: logLevel.NOTHING,
    });
    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: "security-proof", numPartitions: 1, replicationFactor: 1 }],
      });
    } finally {
      await admin.disconnect();
    }
    const producer = kafka.producer();
    try {
      await producer.connect();
      await producer.send({ topic: "security-proof", messages: [{ value: "security-proof" }] });
    } finally {
      await producer.disconnect();
    }
  } else if (mode === "producer") {
    const { createProducer } = await import("../services/worker/src/outbox.ts");
    const producer = createProducer();
    try {
      await producer.connect();
      await producer.send({ topic: "security-proof", messages: [{ value: "security-proof" }] });
    } finally {
      await producer.disconnect();
    }
  } else if (mode === "consumer") {
    const { runKafkaConsumer } = await import("../services/worker/src/async-consumer.ts");
    const result = await runKafkaConsumer({
      topic: "security-proof",
      groupId: `security-${randomBytes(8).toString("hex")}`,
      maxMessages: 1,
      maxWaitMs: 15000,
      eachMessage: async (message) => {
        assert.equal(message.value.toString(), "security-proof");
        return { safeToCommit: true };
      },
    });
    assert.equal(result.processed, 1);
  } else if (mode === "topic-admin") {
    const { ensureAsyncRuntimeTopics } = await import("../services/worker/src/async-runtime.ts");
    await ensureAsyncRuntimeTopics([`security-admin-${randomBytes(8).toString("hex")}`]);
  } else if (mode === "health") {
    const { checkInfrastructure } = await import("../packages/server/src/infrastructure.ts");
    assert.equal((await checkInfrastructure()).kafka, "ok");
  } else throw new Error("Unknown Kafka probe");
}

if (process.argv[2] === "--probe") {
  try {
    await probe(process.argv[3]);
  } catch (error) {
    console.error(`Probe failed: ${error.name}`);
    process.exitCode = 1;
  }
} else {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/test-kafka-security.mjs");
  await run();
}

async function run() {
  const id = randomBytes(8).toString("hex");
  const name = `pstack-kafka-security-${id}`;
  const image = process.env.PSTACK_TEST_KAFKA_SECURITY_IMAGE || "apache/kafka:3.9.1";
  const temp = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const evidenceRoot = verificationDirectory(root, "kafka-security");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(path.join(evidenceRoot, "run-"));
  const password = randomBytes(24).toString("hex");
  const storePassword = randomBytes(24).toString("hex");
  const badPassword = randomBytes(24).toString("hex");
  const secrets = [password, storePassword, badPassword];
  const redact = (text) =>
    secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), String(text));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(DATABASE_|PG|APP_|SESSION_|RATE_LIMIT_|REDIS_|KAFKA_|OUTBOX_|ASYNC_|UPLOAD_|OBJECT_STORAGE_)/.test(
        key,
      )
    )
      delete env[key];
  Object.assign(env, {
    NODE_ENV: "test",
    RATE_LIMIT_DRIVER: "memory",
    UPLOAD_STORAGE_DRIVER: "local",
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
    KAFKAJS_NO_PARTITIONER_WARNING: "1",
  });
  const children = new Set();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  async function command(program, args, options = {}) {
    if (interrupted && !options.cleanup) throw new Error("Kafka security verification interrupted");
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        cwd: temp,
        env: options.env || env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let output = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout || 45000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        const result = { code, timedOut, output: redact(output) };
        if (options.allowFailure || code === 0) resolve(result);
        else reject(new Error(`${program} ${args[0]} failed: ${result.output}`));
      });
    });
  }
  const summary = {
    source: await sourceIdentity(root),
    checkout: root,
    image,
    checks: [],
    status: "running",
  };
  let containerCreated = false;
  console.log(`Kafka security evidence: ${evidence}`);
  try {
    for (const ca of ["ca", "wrong-ca"])
      await command("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${name}-${ca}`,
        "-keyout",
        `${ca}.key`,
        "-out",
        `${ca}.crt`,
      ]);
    await command("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    ]);
    await writeFile(
      path.join(temp, "server.ext"),
      "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
      { mode: 0o600 },
    );
    await command("openssl", [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      "server.ext",
      "-out",
      "server.crt",
    ]);
    await command(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-in",
        "server.crt",
        "-inkey",
        "server.key",
        "-certfile",
        "ca.crt",
        "-out",
        "server.p12",
        "-passout",
        "env:KAFKA_TEST_STORE_PASSWORD",
      ],
      { env: { ...env, KAFKA_TEST_STORE_PASSWORD: storePassword } },
    );
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await writeFile(
      path.join(temp, "server.properties"),
      [
        "process.roles=broker,controller",
        "node.id=1",
        "controller.quorum.voters=1@localhost:9093",
        "listeners=EXTERNAL://:9092,CONTROLLER://localhost:9093,INTERNAL://localhost:9094",
        `advertised.listeners=EXTERNAL://127.0.0.1:${port},INTERNAL://localhost:9094`,
        "listener.security.protocol.map=EXTERNAL:SASL_SSL,CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT",
        "controller.listener.names=CONTROLLER",
        "inter.broker.listener.name=INTERNAL",
        "sasl.enabled.mechanisms=PLAIN",
        `listener.name.external.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required user_proof="${password}";`,
        "ssl.keystore.type=PKCS12",
        "ssl.keystore.location=/security/server.p12",
        `ssl.keystore.password=${storePassword}`,
        "ssl.client.auth=none",
        "offsets.topic.replication.factor=1",
        "transaction.state.log.replication.factor=1",
        "transaction.state.log.min.isr=1",
        "group.initial.rebalance.delay.ms=0",
        "log.dirs=/tmp/kafka-security-data",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    await command("docker", [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `pstack.kafka-security=${id}`,
      "--user",
      "0:0",
      "--publish",
      `127.0.0.1:${port}:9092`,
      "--mount",
      `type=bind,source=${temp},target=/security,readonly`,
      "--tmpfs",
      "/tmp",
      "--entrypoint",
      "/bin/bash",
      image,
      "-ec",
      "/opt/kafka/bin/kafka-storage.sh format --ignore-formatted --cluster-id MkU3OEVBNTcwNTJENDM2Qk --config /security/server.properties >/dev/null && exec /opt/kafka/bin/kafka-server-start.sh /security/server.properties",
    ]);
    containerCreated = true;
    Object.assign(env, {
      KAFKA_BROKERS: `127.0.0.1:${port}`,
      KAFKA_CLIENT_ID: name,
      OUTBOX_PUBLISHER: "kafka",
      KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
      KAFKA_SSL_CA_FILE: path.join(temp, "ca.crt"),
      KAFKA_SASL_MECHANISM: "plain",
      KAFKA_SASL_USERNAME: "proof",
      KAFKA_SASL_PASSWORD: password,
    });
    const tsx = path.join(root, "node_modules/tsx/dist/loader.mjs");
    const probeArgs = (mode) => ["--import", tsx, script, "--probe", mode];
    let ready = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const result = await command(process.execPath, probeArgs("control"), { allowFailure: true });
      if (result.code === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, "SASL_SSL control client did not become ready");
    summary.checks.push({ entry: "control", scenario: "valid", passed: true });
    for (const entry of ["producer", "consumer", "health", "topic-admin", "control"]) {
      for (const scenario of ["valid", "wrong-ca", "wrong-password"]) {
        if (entry === "control" && scenario === "valid") continue;
        const probeEnv = { ...env };
        if (scenario === "wrong-ca") probeEnv.KAFKA_SSL_CA_FILE = path.join(temp, "wrong-ca.crt");
        if (scenario === "wrong-password") probeEnv.KAFKA_SASL_PASSWORD = badPassword;
        const result = await command(process.execPath, probeArgs(entry), {
          env: probeEnv,
          allowFailure: true,
        });
        await writeFile(path.join(evidence, `${entry}-${scenario}.log`), result.output, {
          mode: 0o600,
        });
        const passed =
          !result.timedOut && (scenario === "valid" ? result.code === 0 : result.code !== 0);
        summary.checks.push({
          entry,
          scenario,
          passed,
          exitCode: result.code,
          timedOut: result.timedOut,
        });
        console.log(`${passed ? "PASS" : "FAIL"} ${entry} ${scenario}`);
      }
    }
    assert.ok(
      summary.checks.every((check) => check.passed),
      "Kafka security assertions failed",
    );
    summary.status = "passed";
  } catch (error) {
    summary.status = "failed";
    summary.error = redact(error.message);
    process.exitCode = 1;
    console.error(summary.error);
  } finally {
    if (containerCreated) {
      const logs = await command("docker", ["logs", name], { allowFailure: true, cleanup: true });
      await writeFile(path.join(evidence, "broker.log"), logs.output, { mode: 0o600 });
      const removed = await command("docker", ["rm", "--force", "--volumes", name], {
        allowFailure: true,
        cleanup: true,
      });
      if (removed.code !== 0) {
        summary.cleanupError = removed.output;
        summary.status = "failed";
        process.exitCode = 1;
      }
    }
    await rm(temp, { recursive: true, force: true });
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(summary.source)) {
      summary.status = "failed";
      summary.error = "Source changed during verification";
      process.exitCode = 1;
    }
    await writeFile(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
      mode: 0o600,
    });
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
