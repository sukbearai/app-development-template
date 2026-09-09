import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const name = `pstack-otel-${randomUUID()}`;
const config = fileURLToPath(new URL("../../../deploy/otel-collector.yaml", import.meta.url));
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
try {
  docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::4318",
    "--volume",
    `${config}:/etc/otelcol/config.yaml:ro`,
    "otel/opentelemetry-collector:0.148.0",
  );
  const address = docker("port", name, "4318/tcp");
  const endpoint = `http://${address}/v1/traces`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.status === 405) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(100);
  }
  assert.ok(ready, "collector did not become ready");
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("fixtures/tracing.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        OTEL_ENABLED: "true",
        OTEL_SERVICE_NAME: "pstack-local-proof",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_HEADERS: "",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  const result = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0);
  const logs = result.stdout + result.stderr;
  assert.match(logs, /POST \/api\/trpc\/users\.update/);
  assert.match(logs, /0123456789abcdef0123456789abcdef/);
  assert.doesNotMatch(
    logs,
    /private-user|query-secret|state-secret|baggage-secret|authorization-secret|cookie-secret|body-secret|exception-secret|custom-trace-secret/,
  );
  assert.match(output, /"otelTraceId":"0123456789abcdef0123456789abcdef"/);
  process.stdout.write(
    "Official OpenTelemetry collector accepted the sanitized HTTP span; lifecycle flush and log correlation verified.\n",
  );
} finally {
  docker("rm", "--force", name);
}
