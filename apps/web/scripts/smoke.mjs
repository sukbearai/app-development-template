import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createTestTrpcClient } from "../../../scripts/trpc-client.mjs";

const base = process.env.SMOKE_BASE_URL;
const account = process.env.UI_FLOW_ADMIN_ACCOUNT;
const password = process.env.UI_FLOW_ADMIN_PASSWORD;
if (!base || !account || !password)
  throw new Error(
    "SMOKE_BASE_URL and explicit UI_FLOW_ADMIN_ACCOUNT/PASSWORD are required. Run pnpm test:e2e for an isolated environment.",
  );
const checks = [];
const telemetryPaths = ["/api/telemetry", "/api//telemetry"];
let telemetryAdmissions = 0;
async function call(path, { method = "GET", body, token, cookie, origin, raw, traceId } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (traceId) headers["x-trace-id"] = traceId;
  const options = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (raw !== undefined || body !== undefined) options.body = raw ?? JSON.stringify(body);
  const response = await fetch(new URL(path, base), options);
  const text = await response.text();
  if (response.status === 201 && telemetryPaths.includes(path)) telemetryAdmissions++;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { transportError: text.slice(0, 200) };
  }
  return {
    status: response.status,
    body: payload,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
const client = (headers = {}, onResponse) =>
  createTestTrpcClient({ baseUrl: base, headers, onResponse });
const anonymous = client();
const expectStatus = (operation, status) =>
  assert.rejects(operation, (error) => error.data?.httpStatus === status);
assert.equal((await call("/api/hello")).status, 200);
for (const [path, method] of [
  ["/api/auth/login", "POST"],
  ["/api/auth/me", "GET"],
  ["/api/auth/logout", "POST"],
  ["/api/auth/password", "POST"],
  ["/api/admin/users", "GET"],
  ["/api/admin/users", "POST"],
  ["/api/admin/users/retired", "PATCH"],
  ["/api/admin/users/retired/password", "POST"],
  ["/api/admin/roles", "GET"],
  ["/api/admin/roles", "POST"],
  ["/api/admin/roles/retired", "PATCH"],
  ["/api/admin/audit-logs", "GET"],
  ["/api/admin/outbox-events", "GET"],
  ["/api/admin/async-runtime-health", "GET"],
]) {
  assert.equal((await call(path, { method })).status, 404, `${method} ${path}`);
}
await expectStatus(anonymous.users.list.query({}), 401);
assert.equal((await call("/api/trpc/auth.login", { method: "POST", raw: "{" })).status, 400);
let cookie;
const login = await client({ origin: base }, (response) => {
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")?.split(";")[0];
}).auth.login.mutate({ account, password });
const token = login.token;
assert.ok(token && cookie);
const admin = client({ authorization: `Bearer ${token}` });
assert.equal((await admin.auth.me.query()).user.account, account);
const forged = `${token.split(".")[0]}.forged-secret`;
await client({ authorization: `Bearer ${forged}` }).auth.logout.mutate();
assert.equal((await admin.auth.me.query()).user.account, account);
checks.push("malformed input rejected; forged logout cannot revoke real session");
const suffix = String(Date.now());
const role = {
  id: `role_smoke_${suffix}`,
  name: "Smoke reader",
  permissionIds: ["admin.read"],
  status: "active",
};
const forgedRole = { ...role, id: `role_forged_${suffix}` };
assert.equal(
  (
    await call("/api/trpc/roles.create", {
      method: "POST",
      cookie,
      origin: "https://evil.invalid",
      body: forgedRole,
    })
  ).status,
  403,
);
assert.ok(!(await admin.roles.list.query()).some((entry) => entry.id === forgedRole.id));
checks.push("cross-origin cookie write rejected without creating a role");
await admin.roles.create.mutate(role);
const user = {
  account: `smoke_${suffix}`,
  displayName: "Smoke user",
  password: "Smoke-Test-Password-42!",
  roleIds: [role.id],
  status: "enabled",
};
const created = await admin.users.create.mutate(user);
const userId = created.id;
await expectStatus(admin.users.create.mutate(user), 409);
const readerLogin = await anonymous.auth.login.mutate({
  account: user.account,
  password: user.password,
});
const reader = client({ authorization: `Bearer ${readerLogin.token}` });
await reader.users.list.query({});
await expectStatus(reader.roles.create.mutate(role), 403);
await admin.roles.update.mutate({ id: role.id, status: "inactive" });
await expectStatus(reader.users.list.query({}), 403);
checks.push(
  "read-only role cannot write; inactive role immediately loses access; duplicate user conflicts",
);
await admin.users.update.mutate({ id: userId, status: "disabled" });
await admin.users.update.mutate({ id: userId, status: "enabled" });
await expectStatus(reader.auth.me.query(), 401);
checks.push("disabled then re-enabled user cannot reuse revoked session");
const upload = new FormData();
upload.set("file", new File(["smoke evidence"], `smoke-${suffix}.txt`, { type: "text/plain" }));
const uploaded = await fetch(new URL("/api/uploads", base), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: upload,
});
assert.equal(uploaded.status, 200, await uploaded.clone().text());
assert.ok((await uploaded.json()).data.storageKey);
const invalidUpload = new FormData();
invalidUpload.set("file", new File(["invalid name"], "   ", { type: "text/plain" }));
const rejectedUpload = await fetch(new URL("/api/uploads", base), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: invalidUpload,
});
assert.equal(rejectedUpload.status, 400);
assert.equal((await rejectedUpload.json()).error.code, "VALIDATION_FAILED");
for (const length of [36, 2400, 6000]) {
  const traceId = randomBytes(length).toString("base64url").slice(0, length);
  const recorded = await call("/api/telemetry", {
    method: "POST",
    body: { event: "trace.boundary" },
    traceId,
  });
  assert.equal(recorded.status, 201);
  if (length === 36) assert.equal(recorded.body.traceId, traceId);
  else assert.match(recorded.body.traceId, /^trace_[0-9a-f-]{36}$/);
  assert.equal(recorded.body.data.traceId, recorded.body.traceId);
}
checks.push(
  "blank upload names fail before commit and oversized trace headers use safe server identities",
);
await admin.audit.list.query({});
await admin.outbox.list.query();
await admin.runtime.health.query();
assert.equal(
  (await call("/api/telemetry", { method: "POST", body: { event: "smoke.completed", route: "/" } }))
    .status,
  201,
);
checks.push("upload, audit, outbox, runtime health and telemetry routes work");
await admin.auth.logout.mutate();
await expectStatus(admin.auth.me.query(), 401);
const health = await call("/api/system/health");
assert.equal(health.status, 200, JSON.stringify(health.body));
assert.equal(health.body.data.status, "ok");
const remainingTelemetryAdmissions = 120 - telemetryAdmissions;
for (let index = 0; index < remainingTelemetryAdmissions; index++) {
  const path = telemetryPaths[index % telemetryPaths.length];
  const response = await call(path, {
    method: "POST",
    body: { event: "smoke.telemetry-rate-limit" },
  });
  assert.equal(response.status, 201, `${path}: ${JSON.stringify(response.body)}`);
}
for (const path of telemetryPaths) {
  const response = await call(path, { method: "POST", raw: "{" });
  assert.equal(response.status, 429, `${path}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error.code, "RATE_LIMITED");
  assert.ok(response.body.error.details.retryAfterSeconds > 0);
}
checks.push(
  "canonical and repeated-slash telemetry URLs share the 120-request budget before body parsing",
);
console.log(JSON.stringify({ status: "passed", checks }, null, 2));
