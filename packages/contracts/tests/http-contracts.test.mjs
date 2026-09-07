import { loginRequestSchema, changePasswordRequestSchema } from "../src/schemas.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  apiOperations, apiOperation, findApiOperation, parseApiResponse, apiSuccessSchema,
  createUserRequestSchema, createRoleRequestSchema, telemetryRequestSchema,
  asyncTaskEventMessageSchema, outboxEventSchema, uploadRequestSchema,
} from "../src/index.ts";
import { buildOpenApiDocument, jsonSchema } from "../src/openapi.ts";

const time = "2026-09-07T06:00:00Z";
const user = { id: "user_1", account: "admin", displayName: "管理员", status: "enabled", roleIds: [], createdAt: time };
const session = { id: "session_1", userId: user.id, createdAt: time, expiresAt: time, lastUsedAt: time };
const failure = { traceId: "trace_1", error: { code: "UNAUTHENTICATED", message: "请先登录" } };
const wrap = (data) => ({ traceId: "trace_1", data, meta: {} });

test("request defaults are optional in OpenAPI input and required after parsing", () => {
  for (const [name, schema, input, defaults] of [
    ["CreateUserRequest", createUserRequestSchema, { account: "alice", displayName: "Alice", password: "12345678" }, ["roleIds", "status"]],
    ["CreateRoleRequest", createRoleRequestSchema, { id: "reader", name: "Reader" }, ["permissionIds", "status"]],
    ["TelemetryRequest", telemetryRequestSchema, { event: "page.view" }, ["payload"]],
  ]) {
    const inputSchema = buildOpenApiDocument().components.schemas[name];
    const outputSchema = jsonSchema(schema, "output");
    const parsed = schema.parse(input);
    for (const field of defaults) {
      assert.ok(!inputSchema.required.includes(field), `${name}.${field}: optional input`);
      assert.ok(outputSchema.required.includes(field), `${name}.${field}: required output`);
      assert.notEqual(parsed[field], undefined);
    }
  }
});

test("request schemas reject empty identifiers, short passwords, wrong enums and array members", () => {
  const valid = { account: "alice", displayName: "Alice", password: "12345678" };
  for (const invalid of [
    { ...valid, account: "  " }, { ...valid, password: "1234567" },
    { ...valid, status: "active" }, { ...valid, roleIds: [null] },
  ]) assert.equal(createUserRequestSchema.safeParse(invalid).success, false);
  const generated = buildOpenApiDocument().components.schemas.CreateUserRequest;
  assert.equal(generated.properties.password.minLength, 8);
  assert.equal(generated.properties.account.minLength, 1);
  assert.deepEqual(generated.properties.status.enum, ["enabled", "disabled"]);
});

test("health 503 is the health data envelope, never an API failure envelope", () => {
  const health = wrap({ status: "degraded", service: "web", time, dependencies: { postgres: "unavailable" } });
  assert.deepEqual(parseApiResponse("getApiSystemHealth", 503, health), health);
  assert.throws(() => parseApiResponse("getApiSystemHealth", 503, failure));
  const doc = buildOpenApiDocument();
  assert.equal(doc.paths["/api/system/health"].get.responses[503].content["application/json"].schema.$ref,
    "#/components/schemas/HealthSuccess");
});

test("each operation rejects empty and unrelated successful response shapes", () => {
  for (const operation of apiOperations) {
    for (const [status, response] of Object.entries(operation.responses)) {
      assert.equal(response.schema.safeParse({}).success, false);
      if (Number(status) < 400) {
        assert.throws(() => parseApiResponse(operation.operationId, Number(status), wrap({ arbitrary: true })));
      }
    }
  }
  assert.deepEqual(parseApiResponse("postApiAdminUsers", 201, wrap(user)), wrap(user));
  assert.throws(() => parseApiResponse("postApiAdminUsers", 201, wrap({ ...user, createdAt: "yesterday" })));
  assert.throws(() => parseApiResponse("postApiAdminUsers", 201, wrap({ ...user, roleIds: [3] })));
});

test("login and current-user responses have distinct token requirements", () => {
  const current = { session, user, roles: [], permissions: [] };
  assert.deepEqual(parseApiResponse("getApiAuthMe", 200, wrap(current)), wrap(current));
  assert.throws(() => parseApiResponse("postApiAuthLogin", 200, wrap(current)));
  assert.deepEqual(parseApiResponse("postApiAuthLogin", 200, wrap({ ...current, token: "session.secret" })),
    wrap({ ...current, token: "session.secret" }));
});

test("auth, permission, conflict, not-found, rate and size statuses are declared", () => {
  for (const [operationId, statuses] of [
    ["postApiAuthLogin", [400, 401, 403, 413, 429, 500]],
    ["postApiAdminUsers", [401, 403, 409]], ["postApiAdminRoles", [401, 403, 409]],
    ["patchApiAdminUsersId", [404]], ["patchApiAdminRolesId", [404]],
    ["postApiUploads", [401, 403, 413]], ["postApiTelemetry", [403, 413, 429]],
  ]) {
    for (const status of statuses) assert.deepEqual(parseApiResponse(operationId, status, failure), failure);
  }
  assert.throws(() => parseApiResponse("getApiHello", 201, { message: "Hello from vinext" }), /Undeclared HTTP status/);
  assert.throws(() => parseApiResponse("getApiAuthMe", 401, { traceId: "trace_1", error: {} }));
});

test("matching uses complete route segments and distinguishes methods", () => {
  assert.equal(findApiOperation("patch", "/api/admin/users/user_1")?.operationId, "patchApiAdminUsersId");
  assert.equal(findApiOperation("GET", "/api/admin/users/")?.operationId, "getApiAdminUsers");
  assert.equal(findApiOperation("PATCH", "/api/admin/users/"), undefined);
  assert.equal(findApiOperation("GET", "/api/admin/users/user_1"), undefined);
  assert.equal(findApiOperation("PATCH", "/api/admin/users/user_1/extra"), undefined);
  assert.equal(findApiOperation("GET", "/api/hello")?.operationId, "getApiHello");
});

test("multipart contract validates a File and generates a binary body field", () => {
  assert.equal(uploadRequestSchema.safeParse({ file: "not a file" }).success, false);
  assert.equal(uploadRequestSchema.safeParse({ file: new File(["data"], "a.txt") }).success, true);
  const schema = buildOpenApiDocument().components.schemas.UploadRequest;
  assert.ok(schema.required.includes("file"));
  assert.equal(schema.properties.file.type, "string");
  assert.equal(schema.properties.file.contentEncoding, "binary");
});

test("message boundaries preserve required ownership and retry fields", () => {
  const message = { eventId: "event_1", eventType: "work", traceId: "trace_1", payload: {}, attemptCount: 1 };
  assert.deepEqual(asyncTaskEventMessageSchema.parse(message), message);
  assert.equal(asyncTaskEventMessageSchema.safeParse({ ...message, attemptCount: 0 }).success, false);
  const outbox = { id: "outbox_1", topic: "work", eventType: "work", payload: {}, status: "pending", attempts: 0,
    maxAttempts: 3, nextAttemptAt: time, traceId: "trace_1", createdAt: time, updatedAt: time };
  assert.deepEqual(outboxEventSchema.parse(outbox), outbox);
  assert.equal(outboxEventSchema.safeParse({ ...outbox, maxAttempts: undefined }).success, false);
  assert.ok(buildOpenApiDocument().components.schemas.OutboxEvent.required.includes("maxAttempts"));
});

test("generic success constructor validates its concrete payload", () => {
  const schema = apiSuccessSchema(z.object({ count: z.number().int().nonnegative() }));
  assert.equal(schema.safeParse(wrap({ count: -1 })).success, false);
  assert.deepEqual(schema.parse(wrap({ count: 0 })), wrap({ count: 0 }));
  assert.equal(apiOperation("getApiHello").responses[200].schema.safeParse({ message: "Hello from vinext" }).success, true);
});

test("existing credentials above 256 characters remain usable for login and rotation", () => {
  const password = 'legacy-'.repeat(40);
  assert.equal(loginRequestSchema.parse({ account: 'legacy-user', password }).password, password);
  assert.equal(changePasswordRequestSchema.parse({ currentPassword: password, newPassword: 'replacement-value' }).currentPassword, password);
  assert.equal(createUserRequestSchema.safeParse({ account: 'new', displayName: 'New', password }).success, false);
});
