import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

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
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(15_000),
  });
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
assert.equal((await call("/api/hello")).status, 200);
assert.equal((await call("/api/admin/users")).status, 401);
assert.equal((await call("/api/auth/login", { method: "POST", raw: "{" })).status, 400);
const login = await call("/api/auth/login", {
  method: "POST",
  body: { account, password },
  origin: base,
});
assert.equal(login.status, 200, JSON.stringify(login.body));
const token = login.body.data.token;
const cookie = login.cookie;
assert.ok(token && cookie);
assert.equal((await call("/api/auth/me", { token })).body.data.user.account, account);
const forged = `${token.split(".")[0]}.forged-secret`;
assert.equal(
  (await call("/api/auth/logout", { method: "POST", token: forged, body: {} })).status,
  200,
);
assert.equal((await call("/api/auth/me", { token })).status, 200);
checks.push("malformed input rejected; forged logout cannot revoke real session");
assert.equal(
  (
    await call("/api/admin/roles", {
      method: "POST",
      cookie,
      origin: "https://evil.invalid",
      body: {},
    })
  ).status,
  403,
);
checks.push("cross-origin cookie write rejected");
const suffix = String(Date.now());
const role = {
  id: `role_smoke_${suffix}`,
  name: "Smoke reader",
  permissionIds: ["admin.read"],
  status: "active",
};
assert.equal((await call("/api/admin/roles", { method: "POST", token, body: role })).status, 201);
const user = {
  account: `smoke_${suffix}`,
  displayName: "Smoke user",
  password: "Smoke-Test-Password-42!",
  roleIds: [role.id],
  status: "enabled",
};
const created = await call("/api/admin/users", { method: "POST", token, body: user });
assert.equal(created.status, 201, JSON.stringify(created.body));
const userId = created.body.data.id;
assert.equal((await call("/api/admin/users", { method: "POST", token, body: user })).status, 409);
const reader = await call("/api/auth/login", {
  method: "POST",
  body: { account: user.account, password: user.password },
});
assert.equal(reader.status, 200);
const readerToken = reader.body.data.token;
assert.equal((await call("/api/admin/users", { token: readerToken })).status, 200);
assert.equal(
  (await call("/api/admin/roles", { method: "POST", token: readerToken, body: role })).status,
  403,
);
assert.equal(
  (
    await call(`/api/admin/roles/${role.id}`, {
      method: "PATCH",
      token,
      body: { status: "inactive" },
    })
  ).status,
  200,
);
assert.equal((await call("/api/admin/users", { token: readerToken })).status, 403);
checks.push(
  "read-only role cannot write; inactive role immediately loses access; duplicate user conflicts",
);
assert.equal(
  (
    await call(`/api/admin/users/${userId}`, {
      method: "PATCH",
      token,
      body: { status: "disabled" },
    })
  ).status,
  200,
);
assert.equal(
  (
    await call(`/api/admin/users/${userId}`, {
      method: "PATCH",
      token,
      body: { status: "enabled" },
    })
  ).status,
  200,
);
assert.equal((await call("/api/auth/me", { token: readerToken })).status, 401);
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
assert.equal((await call("/api/admin/audit-logs", { token })).status, 200);
assert.equal((await call("/api/admin/outbox-events", { token })).status, 200);
assert.equal((await call("/api/admin/async-runtime-health", { token })).status, 200);
assert.equal(
  (await call("/api/telemetry", { method: "POST", body: { event: "smoke.completed", route: "/" } }))
    .status,
  201,
);
checks.push("upload, audit, outbox, runtime health and telemetry routes work");
assert.equal((await call("/api/auth/logout", { method: "POST", token, body: {} })).status, 200);
assert.equal((await call("/api/auth/me", { token })).status, 401);
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
