import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { rpcFetch, requestError } from "../../lib/trpc-client.ts";
import { createAppQueryClient, retryApiQuery } from "../../lib/api-query-policy.ts";

test("real tRPC failures preserve business details, trace and public versus private session policy", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "请先登录",
          code: -32001,
          data: {
            code: "UNAUTHORIZED",
            httpStatus: 401,
            businessCode: "UNAUTHENTICATED",
            traceId: "trpc-test",
            details: {},
          },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let expired = 0;
  const queryClient = createAppQueryClient(() => {
    expired++;
  });
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, gcTime: 0 },
  });
  t.after(() => queryClient.clear());
  const client = createTRPCClient({
    links: [
      httpLink({ url: `http://127.0.0.1:${server.address().port}/api/trpc`, fetch: rpcFetch }),
    ],
  });
  const trpc = createTRPCOptionsProxy({ client, queryClient });
  await assert.rejects(
    queryClient.fetchQuery(
      trpc.auth.me.queryOptions(undefined, { meta: { authentication: "public" } }),
    ),
    (error) => {
      const normalized = requestError(error);
      assert.equal(normalized.status, 401);
      assert.equal(normalized.traceId, "trpc-test");
      assert.equal(normalized.code, "UNAUTHENTICATED");
      return true;
    },
  );
  assert.equal(expired, 0);
  queryClient.setQueryData(["private"], "private data");
  await assert.rejects(queryClient.fetchQuery(trpc.users.list.queryOptions({ page: 1 })));
  assert.equal(expired, 1);
  assert.equal(queryClient.getQueryData(["private"]), undefined);
});

test("gateway errors keep HTTP retry policy without exposing proxy body", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>proxy-secret</html>", { status: 502, headers: { "retry-after": "2" } }),
  );
  const client = createTRPCClient({
    links: [httpLink({ url: "http://localhost/api/trpc", fetch: rpcFetch })],
  });
  await assert.rejects(client.auth.me.query(), (error) => {
    const normalized = requestError(error);
    assert.equal(normalized.status, 502);
    assert.equal(normalized.retryAfterMs, 2000);
    assert.equal(retryApiQuery(0, error), true);
    assert.doesNotMatch(normalized.message, /proxy-secret/);
    return true;
  });
});

test("query cancellation aborts an active tRPC HTTP response", async (t) => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  let connectionClosed;
  const closed = new Promise((resolve) => {
    connectionClosed = resolve;
  });
  const server = createServer((_req, res) => {
    res.on("close", connectionClosed);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"result":');
    requestStarted();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const queryClient = createAppQueryClient(() => {});
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, gcTime: 0 },
  });
  t.after(() => queryClient.clear());
  const client = createTRPCClient({
    links: [
      httpLink({ url: `http://127.0.0.1:${server.address().port}/api/trpc`, fetch: rpcFetch }),
    ],
  });
  const trpc = createTRPCOptionsProxy({ client, queryClient });
  const pending = queryClient.fetchQuery(
    trpc.roles.list.queryOptions(undefined, { trpc: { abortOnUnmount: true } }),
  );
  const rejected = assert.rejects(pending);
  await started;
  await queryClient.cancelQueries({ queryKey: trpc.roles.list.queryKey() });
  await rejected;
  await closed;
});
