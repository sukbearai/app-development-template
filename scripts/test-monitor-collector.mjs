import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { sourceIdentity } from "./verification-evidence.mjs";
import { verificationDirectory } from "./verification-output.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceRoot = verificationDirectory(root, "monitor-collector");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(path.join(evidenceRoot, "run-"));
const summary = { status: "running", checks: [], cleanupErrors: [] };
const report = () =>
  writeFile(path.join(evidence, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    mode: 0o600,
  });
await report();
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: args[0] === "rm" || (args[0] === "volume" && args[1] === "rm") ? 30000 : 120000,
  }).trim();
let directory;
const name = `pstack-collector-${randomUUID()}`;
const volume = `${name}-queue`;
const config = fileURLToPath(new URL("../deploy/otel-collector.yaml", import.meta.url));
let receiver;
let receiverError;
const containers = new Set();
let volumeCreated = false;
try {
  summary.source = await sourceIdentity(root);
  await report();
  const toolchain = JSON.parse(
    await readFile(new URL("./toolchain-lock.json", import.meta.url), "utf8"),
  );
  summary.collectorImage = toolchain.images.otelContrib;
  directory = await mkdtemp(path.join(tmpdir(), "pstack-collector-"));
  const keyFile = path.join(directory, "key.pem"),
    certFile = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=host.docker.internal",
      "-addext",
      "subjectAltName=DNS:host.docker.internal",
    ],
    { stdio: "ignore" },
  );
  let available = false,
    failures = 0,
    deliveries = 0;
  receiver = createServer(
    { key: await readFile(keyFile), cert: await readFile(certFile) },
    async (request, response) => {
      try {
        assert.equal(request.url, "/v1/traces");
        assert.equal(request.headers.authorization, "Bearer local-collector-fixture");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        assert.ok(Buffer.concat(chunks).length > 0);
        if (available) deliveries++;
        else failures++;
        response.writeHead(available ? 200 : 503, { "content-type": "application/x-protobuf" });
        response.end();
      } catch (error) {
        receiverError = error;
        response.destroy();
      }
    },
  );
  receiver.listen(0, "0.0.0.0");
  await once(receiver, "listening");
  const environment = [
    "--env",
    `OTEL_BACKEND_AUTHORITY=host.docker.internal:${receiver.address().port}`,
    "--env",
    "OTEL_BACKEND_TOKEN=local-collector-fixture",
    "--env",
    "OTEL_BACKEND_CA_FILE=/etc/otelcol/backend-ca.pem",
  ];
  const mounts = [
    "--volume",
    `${config}:/etc/otelcol/config.yaml:ro`,
    "--volume",
    `${certFile}:/etc/otelcol/backend-ca.pem:ro`,
  ];
  containers.add(`${name}-validate`);
  docker(
    "run",
    "--name",
    `${name}-validate`,
    ...environment,
    ...mounts,
    toolchain.images.otelContrib,
    "validate",
    "--config=/etc/otelcol/config.yaml",
  );
  summary.checks.push("pinned_production_configuration_validated");
  volumeCreated = true;
  docker("volume", "create", volume);
  containers.add(name);
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--user",
    "0:0",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    "127.0.0.1::4318",
    ...environment,
    ...mounts,
    "--volume",
    `${volume}:/var/lib/otelcol`,
    toolchain.images.otelContrib,
    "--config=/etc/otelcol/config.yaml",
  );
  const endpoint = `http://${docker("port", name, "4318/tcp")}/v1/traces`;
  async function waitFor(check, label) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (receiverError) throw receiverError;
      if (await check()) return;
      await delay(100);
    }
    throw new Error(label);
  }
  await waitFor(async () => {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      return response.status === 405;
    } catch {
      return false;
    }
  }, "collector_not_ready");
  const now = BigInt(Date.now()) * 1000000n;
  const sent = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "durable-queue-proof" },
              spans: [
                {
                  traceId: "0123456789abcdef0123456789abcdef",
                  spanId: "0123456789abcdef",
                  name: "queue-restart-proof",
                  kind: 1,
                  startTimeUnixNano: String(now),
                  endTimeUnixNano: String(now + 1000000n),
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert.equal(sent.status, 200);
  await sent.body?.cancel();
  await waitFor(() => failures > 0, "receiver_outage_not_observed");
  summary.checks.push("tls_export_observed_during_receiver_outage");
  docker("kill", "--signal", "KILL", name);
  available = true;
  docker("start", name);
  await waitFor(() => deliveries > 0, "persistent_queue_did_not_recover");
  summary.checks.push("persistent_queue_delivered_after_sigkill_restart");
} catch (error) {
  summary.error = error.message;
} finally {
  for (const container of containers) {
    try {
      docker("rm", "--force", container);
    } catch {
      summary.cleanupErrors.push(`container_removal_failed:${container}`);
    }
  }
  if (volumeCreated) {
    try {
      docker("volume", "rm", "--force", volume);
    } catch {
      summary.cleanupErrors.push(`volume_removal_failed:${volume}`);
    }
  }
  if (receiver) {
    try {
      receiver.closeAllConnections();
      await new Promise((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      );
    } catch {
      summary.cleanupErrors.push("receiver_close_failed");
    }
  }
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      summary.cleanupErrors.push("temporary_directory_removal_failed");
    }
  }
  try {
    summary.sourceAtEnd = await sourceIdentity(root);
    assert.deepEqual(summary.sourceAtEnd, summary.source, "Source changed during verification");
  } catch {
    summary.error ??= "source_changed_or_unavailable";
  }
  if (receiverError) summary.error ??= receiverError.message;
  summary.status =
    !summary.error && !summary.cleanupErrors.length && summary.checks.length === 3
      ? "passed"
      : "failed";
  await report();
  process.stdout.write(
    `Monitor collector verification ${summary.status}: ${path.join(evidence, "summary.json")}\n`,
  );
  if (summary.status !== "passed") process.exitCode = 1;
}
