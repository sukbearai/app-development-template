import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { capacityFailure } from "../capacity-diagnostics.mjs";
import { assessCapacityResponse } from "../capacity-summary.mjs";
import { issueCapacityTrpc } from "../capacity-trpc.mjs";

const role = {
  id: "capacity_role",
  name: "Capacity reader",
  status: "active",
  permissionIds: ["admin.read"],
};
const timestamp = "2026-09-09T00:00:00.000Z";

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("capacity sends real nonbatch tRPC role calls and measures the original HTTP responses", async () => {
  const requests = [];
  await serve(
    async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        url: request.url,
        method: request.method,
        body,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { data: request.method === "GET" ? [role] : role } }));
    },
    async (baseUrl) => {
      for (const operation of ["write", "read"]) {
        const started = performance.now();
        const result = await issueCapacityTrpc({
          baseUrl,
          operation,
          input: role,
          token: "capacity-token",
          signal: AbortSignal.timeout(1000),
        });
        assert.ok(performance.now() - started > 0);
        assert.equal(result.response.status, 200);
        assert.equal(
          assessCapacityResponse(operation, result.response, result.payload).outcome,
          "success",
        );
      }
    },
  );
  assert.deepEqual(requests, [
    {
      url: "/api/trpc/roles.create",
      method: "POST",
      body: JSON.stringify(role),
      authorization: "Bearer capacity-token",
    },
    {
      url: "/api/trpc/roles.list",
      method: "GET",
      body: "",
      authorization: "Bearer capacity-token",
    },
  ]);
});

test("capacity retains tRPC error HTTP status and rejects malformed successful procedure data", async () => {
  const failure = {
    error: {
      message: "private failure",
      code: -32603,
      data: {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        businessCode: "DATABASE_ERROR",
        traceId: "trace_capacity",
      },
    },
  };
  for (const [status, payload, expectedStage] of [
    [500, failure, "response_status"],
    [200, { result: { data: [{ id: "incomplete" }] } }, "response_contract"],
    [200, { data: [role] }, "response_contract"],
  ]) {
    await serve(
      (_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      },
      async (baseUrl) => {
        const result = await issueCapacityTrpc({
          baseUrl,
          operation: "read",
          token: "capacity-token",
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(result.response.status, status);
        const assessment = assessCapacityResponse("read", result.response, result.payload);
        assert.equal(assessment.outcome, "failed");
        assert.equal(assessment.diagnostic.stage, expectedStage);
        assert.doesNotMatch(JSON.stringify(assessment), /private failure/);
      },
    );
  }
});

test("capacity preserves response-body decode failures through the real tRPC client", async () => {
  await serve(
    (_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("bad gateway");
    },
    async (baseUrl) => {
      const result = await issueCapacityTrpc({
        baseUrl,
        operation: "read",
        token: "capacity-token",
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(result.response.status, 502);
      assert.equal(result.diagnostic.stage, "response_body");
      assert.equal(result.diagnostic.name, "SyntaxError");
    },
  );
});

test("capacity retains request timeout classification through the real tRPC client", async () => {
  await serve(
    () => {},
    async (baseUrl) => {
      await assert.rejects(
        issueCapacityTrpc({
          baseUrl,
          operation: "read",
          token: "capacity-token",
          signal: AbortSignal.timeout(50),
        }),
        (error) => capacityFailure("request", error).name === "TimeoutError",
      );
    },
  );
});

test("capacity login uses the mutation protocol and validates the returned session", async () => {
  const input = { account: "capacity-admin", password: "capacity-password" };
  const login = {
    token: "capacity-token",
    session: {
      id: "session_capacity",
      userId: "user_capacity",
      expiresAt: timestamp,
      createdAt: timestamp,
      lastUsedAt: timestamp,
    },
    user: {
      id: "user_capacity",
      account: input.account,
      displayName: "Capacity administrator",
      status: "enabled",
      roleIds: [role.id],
      createdAt: timestamp,
    },
    roles: [role],
    permissions: [{ id: "admin.read", name: "Read administration" }],
  };
  await serve(
    async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(request.url, "/api/trpc/auth.login");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, undefined);
      assert.deepEqual(JSON.parse(body), input);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { data: login } }));
    },
    async (baseUrl) => {
      const result = await issueCapacityTrpc({
        baseUrl,
        operation: "login",
        input,
        signal: AbortSignal.timeout(1000),
      });
      const assessment = assessCapacityResponse("login", result.response, result.payload);
      assert.equal(assessment.outcome, "success");
      assert.deepEqual(assessment.data, login);
    },
  );
});

test("capacity retains a disconnected response body status and socket cause through tRPC", async () => {
  await serve(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      response.write('{"result":{"data":');
      setTimeout(() => response.destroy(), 10);
    },
    async (baseUrl) => {
      const result = await issueCapacityTrpc({
        baseUrl,
        operation: "read",
        token: "capacity-token",
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.diagnostic.stage, "response_body");
      assert.equal(result.diagnostic.name, "TypeError");
      assert.equal(result.diagnostic.causeCode, "UND_ERR_SOCKET");
    },
  );
});
