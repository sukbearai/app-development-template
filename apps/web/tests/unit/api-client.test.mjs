import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { requestJson, ApiRequestError } from "../../components/api-client.ts";

test("client parses success with the caller schema and rejects wrong output", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ traceId: "test", data: { count: "invalid" } }),
  );
  await assert.rejects(requestJson("/api/test", z.object({ count: z.number() })));
});

test("client preserves server error code, trace and details without exposing raw error bodies", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        traceId: "trace_example",
        error: { code: "CONFLICT", message: "已存在", details: { field: "account" } },
      },
      { status: 409 },
    ),
  );
  await assert.rejects(requestJson("/api/test", z.unknown()), (error) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.traceId, "trace_example");
    assert.equal(error.code, "CONFLICT");
    assert.deepEqual(error.details, { field: "account" });
    return true;
  });
});

test("client does not show arbitrary proxy HTML to the user", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>internal server information</html>", { status: 502 }),
  );
  await assert.rejects(
    requestJson("/api/test", z.unknown()),
    (error) => error.message === "请求失败 (502)" && error.code === "INVALID_RESPONSE",
  );
});

import { createServer } from "node:http";
import { once } from "node:events";
import { parseApiResponse, parseRetryAfter } from "../../components/api-client.ts";

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("timeout covers both response headers and a stalled response body", async () => {
  for (const sendHeaders of [false, true]) {
    await withServer(
      (_request, response) => {
        if (sendHeaders) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write("{");
        }
      },
      async (url) => {
        await assert.rejects(
          requestJson(url, z.unknown(), { timeoutMs: 25 }),
          (error) => error.kind === "timeout",
        );
      },
    );
  }
});

test("caller cancellation remains distinct from timeout and aborts the body read", async () => {
  const controller = new AbortController();
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      controller.abort();
    },
    async (url) => {
      await assert.rejects(
        requestJson(url, z.unknown(), { signal: controller.signal }),
        (error) => error.kind === "cancelled",
      );
    },
  );
});

test("successful payload uses the contracts envelope and JSON writes run once", async () => {
  let requests = 0;
  await withServer(
    (request, response) => {
      requests += 1;
      assert.equal(request.headers["content-type"], "application/json");
      response.writeHead(503, { "content-type": "application/json", "retry-after": "2" });
      response.end(
        JSON.stringify({ traceId: "trace", error: { code: "UNAVAILABLE", message: "暂不可用" } }),
      );
    },
    async (url) => {
      await assert.rejects(
        requestJson(url, z.unknown(), { method: "POST", body: "{}" }),
        (error) => error.kind === "http" && error.retryAfterMs === 2000,
      );
    },
  );
  assert.equal(requests, 1);
});

test("Retry-After supports delay seconds and HTTP dates without accepting malformed delays", () => {
  const now = Date.parse("Wed, 09 Sep 2026 01:00:00 GMT");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter("Wed, 09 Sep 2026 01:00:03 GMT", now), 3000);
  assert.equal(parseRetryAfter("Wed, 09 Sep 2026 00:59:59 GMT", now), 0);
  assert.equal(parseRetryAfter(null, now), undefined);
  for (const value of ["invalid", "-1", "1.5", "9".repeat(400)])
    assert.equal(parseRetryAfter(value, now), undefined);
});

test("network errors are normalized and invalid success envelopes do not pass validation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(requestJson("/api/test", z.unknown()), (error) => error.kind === "network");
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ data: true }));
  await assert.rejects(
    requestJson("/api/test", z.boolean()),
    (error) => error.kind === "invalid-response",
  );
});

test("shared XHR parser validates unknown data without leaking schema failures", () => {
  assert.deepEqual(
    parseApiResponse(
      { traceId: "trace", data: { count: 2 } },
      200,
      z.object({ count: z.number() }),
    ),
    { count: 2 },
  );
  for (const payload of [
    undefined,
    null,
    "<html>secret</html>",
    { traceId: "trace", data: "secret" },
  ]) {
    assert.throws(
      () => parseApiResponse(payload, 200, z.number()),
      (error) => error.kind === "invalid-response" && error.message === "服务器响应格式无效",
    );
  }
  assert.throws(
    () => parseApiResponse("<html>secret</html>", 502, z.unknown(), "上传失败"),
    (error) => error.kind === "http" && error.message === "上传失败",
  );
});
