import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { request as playwrightRequest } from "@playwright/test";
import { createTestTrpcClient } from "../trpc-client.mjs";

async function fixture(t, handler, playwright = false) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = playwright ? await playwrightRequest.newContext() : undefined;
  t.after(async () => {
    await request?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, request };
}

async function rejectsPromptly(operation) {
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("test watchdog expired")), 1000);
        }),
      ]),
      (error) => /timeout|aborted|cancelled/i.test(error.message),
    );
  } finally {
    clearTimeout(timer);
  }
}

for (const playwright of [false, true]) {
  const transport = playwright ? "Playwright" : "native fetch";
  for (const stage of ["headers", "body"]) {
    test(`${transport}: deadline rejects stalled response ${stage}`, async (t) => {
      const options = await fixture(
        t,
        (_incoming, outgoing) => {
          if (stage === "body") {
            outgoing.writeHead(200, { "content-type": "application/json" });
            outgoing.write('{"result":{"data":');
          }
        },
        playwright,
      );
      const client = createTestTrpcClient({ ...options, timeoutMs: 80 });
      await rejectsPromptly(client.probe.query());
    });
  }

  test(`${transport}: caller cancellation rejects a pending request`, async (t) => {
    let received;
    const incomingRequest = new Promise((resolve) => {
      received = resolve;
    });
    const options = await fixture(t, () => received(), playwright);
    const client = createTestTrpcClient({ ...options, timeoutMs: 500 });
    const controller = new AbortController();
    const operation = client.probe.query(undefined, { signal: controller.signal });
    await incomingRequest;
    controller.abort(new Error("caller cancelled"));
    await rejectsPromptly(operation);
  });
}

test("response callback shares the request deadline", async (t) => {
  const options = await fixture(t, (_incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end('{"result":{"data":{"value":1}}}');
  });
  const client = createTestTrpcClient({
    ...options,
    timeoutMs: 80,
    onResponse: () => new Promise(() => {}),
  });
  await rejectsPromptly(client.probe.query());
});

test("response status and body remain available to callbacks and the tRPC decoder", async (t) => {
  const options = await fixture(t, (_incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json");
    outgoing.setHeader("x-proof", "transport-response");
    outgoing.end('{"result":{"data":{"value":1}}}');
  });
  let observed;
  const client = createTestTrpcClient({
    ...options,
    onResponse: async (response) => {
      observed = {
        status: response.status,
        header: response.headers.get("x-proof"),
        body: await response.clone().json(),
      };
    },
  });
  assert.deepEqual(await client.probe.query(), { value: 1 });
  assert.deepEqual(observed, {
    status: 200,
    header: "transport-response",
    body: { result: { data: { value: 1 } } },
  });
});

test("HTTP errors remain visible to capacity sampling and reject through tRPC", async (t) => {
  const body = {
    error: {
      message: "rate limit reached",
      code: -32029,
      data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, businessCode: "RATE_LIMITED" },
    },
  };
  const options = await fixture(t, (_incoming, outgoing) => {
    outgoing.writeHead(429, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(body));
  });
  let observed;
  const client = createTestTrpcClient({
    ...options,
    onResponse: async (response) => {
      observed = { status: response.status, body: await response.clone().json() };
    },
  });
  await assert.rejects(client.probe.query(), (error) => error.data.httpStatus === 429);
  assert.deepEqual(observed, { status: 429, body });
});
