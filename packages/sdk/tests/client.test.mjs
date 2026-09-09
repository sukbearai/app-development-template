import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createApiClient } from "../src/index.ts";

async function server(t, status, payload) {
  const requests = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  );
  return {
    client: createApiClient({ baseUrl: `http://127.0.0.1:${http.address().port}` }),
    requests,
  };
}

const denied = {
  traceId: "sdk-test",
  error: { code: "UNAUTHENTICATED", message: "Login required" },
};

test("sends a typed operation over HTTP and returns a validated success", async (t) => {
  const { client, requests } = await server(t, 200, { message: "Hello from vinext" });
  const result = await client.GET("/api/hello");
  assert.deepEqual(result.data, { message: "Hello from vinext" });
  assert.equal(result.error, undefined);
  assert.equal(requests[0].url, "/api/hello");
});

test("rejects invalid request values before contacting the server", async (t) => {
  const { client, requests } = await server(t, 401, denied);
  await assert.rejects(
    client.POST("/api/telemetry", {
      body: { event: "" },
    }),
    /too_small/,
  );
  assert.equal(requests.length, 0);
});

test("preserves declared error responses for the caller", async (t) => {
  const { client } = await server(t, 401, denied);
  const result = await client.GET("/api/system/metrics");
  assert.deepEqual(result.error, denied);
  assert.equal(result.data, undefined);
  assert.equal(result.response.status, 401);
});

test("rejects successful HTTP responses that violate the Zod contract", async (t) => {
  const { client } = await server(t, 200, { message: "untrusted upstream" });
  await assert.rejects(client.GET("/api/hello"), /invalid_value/);
});

test("rejects undocumented status codes", async (t) => {
  const { client } = await server(t, 202, { message: "Hello from vinext" });
  await assert.rejects(client.GET("/api/hello"), /Undeclared HTTP status 202/);
});

test("sends telemetry JSON and validates its returned event", async (t) => {
  const event = {
    id: "telemetry_1",
    event: "page.view",
    payload: {},
    traceId: "sdk-test",
    occurredAt: "2026-09-09T00:00:00Z",
  };
  const { client, requests } = await server(t, 201, { traceId: "sdk-test", data: event });
  const result = await client.POST("/api/telemetry", { body: { event: "page.view", payload: {} } });
  assert.deepEqual(result.data.data, event);
  assert.equal(requests[0].url, "/api/telemetry");
  assert.deepEqual(JSON.parse(requests[0].body), { event: "page.view", payload: {} });
});

test("rejects removed internal REST operations before sending a request", async (t) => {
  const { client, requests } = await server(t, 401, denied);
  await assert.rejects(client.GET("/api/auth/me"), /Unknown API operation/);
  await assert.rejects(client.POST("/api/admin/users", { body: {} }), /Unknown API operation/);
  assert.equal(requests.length, 0);
});

test("validates multipart file uploads with a caller-supplied serializer", async (t) => {
  const { client, requests } = await server(t, 401, denied);
  const result = await client.POST("/api/uploads", {
    body: { file: new File(["SDK upload"], "proof.txt", { type: "text/plain" }) },
    bodySerializer(body) {
      const form = new FormData();
      form.set("file", body.file);
      return form;
    },
  });
  assert.equal(result.error.error.code, "UNAUTHENTICATED");
  assert.match(requests[0].headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(requests[0].body, /SDK upload/);
});
