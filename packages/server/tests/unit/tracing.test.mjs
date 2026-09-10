import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { envSchema } from "../../src/env-schema.ts";

async function runTracing(environment, expectedExitCode = 0) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", new URL("../fixtures/tracing.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        OTEL_ENABLED: "false",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  assert.equal(code, expectedExitCode, stderr);
  return {
    stdout,
    stderr,
    rows: stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

test("tracing is off by default and validates exporter configuration", () => {
  assert.equal(envSchema.parse({}).OTEL_ENABLED, false);
  for (const values of [
    { OTEL_ENABLED: "yes" },
    { OTEL_TRACES_SAMPLER_ARG: "-1" },
    { OTEL_TRACES_SAMPLER_ARG: "1.1" },
    ...[
      "ftp://collector/traces",
      "https://user:secret@collector/traces",
      "https://collector/traces?token=secret",
      "https://collector/traces#secret",
    ].map((endpoint) => ({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint })),
  ])
    assert.equal(envSchema.safeParse(values).success, false);
});

test(
  "HTTP spans reach the OTLP receiver on drain and correlate with logs without request secrets",
  { timeout: 20000 },
  async (t) => {
    const received = [];
    const collector = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    collector.listen(0, "127.0.0.1");
    await once(collector, "listening");
    t.after(() => new Promise((resolve) => collector.close(resolve)));
    const endpoint = `http://127.0.0.1:${collector.address().port}/v1/traces`;
    const off = await runTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint });
    assert.equal(off.rows.find((row) => "responseTraceId" in row).responseTraceId, null);
    assert.equal(received.length, 0);
    const on = await runTracing({
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20collector-credential",
      OTEL_SERVICE_NAME: "pstack-trace-test",
    });
    assert.equal(received.length, 1, "drain flushes the pending batch before process exit");
    assert.equal(received[0].path, "/v1/traces");
    assert.equal(received[0].authorization, "Bearer collector-credential");
    const resource = received[0].body.resourceSpans[0];
    assert.ok(
      resource.resource.attributes.some(
        (attribute) =>
          attribute.key === "service.name" && attribute.value.stringValue === "pstack-trace-test",
      ),
    );
    const [span] = resource.scopeSpans[0].spans;
    assert.equal(span.name, "POST /api/trpc/users.update");
    assert.equal(span.traceId, "0123456789abcdef0123456789abcdef");
    assert.equal(span.parentSpanId, "0123456789abcdef");
    assert.equal(span.status.code, 2);
    assert.ok(
      span.attributes.some(
        (attribute) =>
          attribute.key === "http.response.status_code" && Number(attribute.value.intValue) === 500,
      ),
    );
    const response = on.rows.find((row) => "responseTraceId" in row);
    assert.equal(response.responseTraceId, span.traceId);
    const access = on.rows.find((row) => row.message === "http request");
    assert.equal(access.fields.otelTraceId, span.traceId);
    assert.equal(access.fields.otelSpanId, span.spanId);
    assert.equal(access.fields.traceId, "custom-trace-secret");
    assert.doesNotMatch(
      JSON.stringify(received[0].body),
      /private-user|query-secret|state-secret|baggage-secret|authorization-secret|cookie-secret|body-secret|exception-secret|custom-trace-secret|collector-credential/,
    );
    assert.doesNotMatch(on.stdout + on.stderr, /collector-credential|exception-secret/);
  },
);

test("collector failure cannot replace the application response", { timeout: 15000 }, async () => {
  const result = await runTracing(
    { OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces" },
    1,
  );
  assert.equal(result.rows.find((row) => "responseTraceId" in row).status, 500);
});
