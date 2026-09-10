import assert from "node:assert/strict";
import { test } from "node:test";
import { MutationObserver } from "@tanstack/react-query";
import { ApiRequestError } from "../../lib/api-client.ts";
import {
  apiQueryRetryDelay,
  createAppQueryClient,
  handleApiSessionError,
  retryApiQuery,
} from "../../lib/api-query-policy.ts";

const httpError = (status, retryAfterMs) =>
  new ApiRequestError("失败", {
    kind: "http",
    status,
    code: "FAILED",
    retryAfterMs,
  });

test("query retries only transient failures with a bounded server retry window", () => {
  for (const kind of ["network", "timeout"])
    assert.equal(retryApiQuery(0, new ApiRequestError("失败", { kind })), true);
  for (const kind of ["cancelled", "invalid-response"])
    assert.equal(retryApiQuery(0, new ApiRequestError("失败", { kind, status: 200 })), false);
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503])
    assert.equal(retryApiQuery(0, httpError(status)), false);
  for (const status of [502, 504]) assert.equal(retryApiQuery(0, httpError(status)), true);
  for (const status of [429, 502, 503, 504]) {
    assert.equal(retryApiQuery(0, httpError(status, 2000)), true);
    for (const delay of [61000, 2 ** 32, Infinity, NaN, -1]) {
      assert.equal(retryApiQuery(0, httpError(status, delay)), false);
      assert.ok(apiQueryRetryDelay(0, httpError(status, delay)) <= 60_000);
    }
    assert.equal(apiQueryRetryDelay(0, httpError(status, 2000)), 2000);
  }
  assert.equal(retryApiQuery(2, httpError(502)), false);
  assert.equal(retryApiQuery(0, new Error("unclassified")), false);
});

test("session failure clears private cache once while login failures remain local", async () => {
  let expired = 0;
  const client = createAppQueryClient(() => {
    expired += 1;
  });
  client.setQueryDefaults([], { gcTime: 0 });
  client.setQueryData(["private"], { account: "admin" });
  const login = new MutationObserver(client, {
    gcTime: 0,
    mutationFn: async () => {
      throw httpError(401);
    },
    meta: { authentication: "public" },
  });
  await assert.rejects(login.mutate());
  assert.equal(expired, 0);
  assert.ok(client.getQueryData(["private"]));
  await assert.rejects(
    client.fetchQuery({
      queryKey: ["protected"],
      queryFn: async () => {
        throw httpError(401);
      },
    }),
  );
  assert.equal(expired, 1);
  assert.equal(client.getQueryData(["private"]), undefined);
  client.clear();
});

test("mutations never retry and query cache remains fresh for thirty seconds", async () => {
  const client = createAppQueryClient(() => {});
  let writes = 0;
  let reads = 0;
  const mutation = new MutationObserver(client, {
    gcTime: 0,
    mutationFn: async () => {
      writes += 1;
      throw httpError(503, 0);
    },
  });
  await assert.rejects(mutation.mutate());
  assert.equal(writes, 1);
  const query = { queryKey: ["fresh"], queryFn: async () => ++reads };
  assert.equal(await client.fetchQuery(query), 1);
  assert.equal(await client.fetchQuery(query), 1);
  client.clear();
});

test("XHR session failures share the query session handler and only redirect once", () => {
  let expired = 0;
  const client = createAppQueryClient(() => {
    expired += 1;
  });
  client.setQueryData(["private"], "sensitive data");
  handleApiSessionError(client, httpError(401), "public");
  handleApiSessionError(client, httpError(403));
  assert.equal(expired, 0);
  assert.equal(client.getQueryData(["private"]), "sensitive data");
  handleApiSessionError(client, httpError(401));
  handleApiSessionError(client, httpError(401));
  assert.equal(expired, 1);
  assert.equal(client.getQueryData(["private"]), undefined);
  client.clear();
});
