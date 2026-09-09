import test from "node:test";
import assert from "node:assert/strict";
import {
  userPageQuerySchema,
  auditPageQuerySchema,
  readPageSearchParams,
} from "../src/admin-pages.ts";
import { buildOpenApiDocument } from "../src/openapi.ts";

test("directory queries default, validate bounded pagination and reject repeated parameters", () => {
  assert.deepEqual(userPageQuerySchema.parse({}), {
    page: 1,
    limit: 25,
    search: "",
    direction: "desc",
    status: "all",
    sort: "createdAt",
  });
  assert.equal(
    auditPageQuerySchema.parse({ action: " auth.login ", search: " trace " }).action,
    "auth.login",
  );
  for (const invalid of ["0", "-1", "1.5", "10001", "Infinity", ["1"], null]) {
    assert.equal(userPageQuerySchema.safeParse({ page: invalid }).success, false);
  }
  for (const invalid of ["0", "101", "2.5"])
    assert.equal(auditPageQuerySchema.safeParse({ limit: invalid }).success, false);
  assert.equal(userPageQuerySchema.safeParse({ sort: "passwordHash" }).success, false);
  assert.equal(auditPageQuerySchema.safeParse({ direction: "sideways" }).success, false);
  assert.equal(
    userPageQuerySchema.safeParse(readPageSearchParams(new URLSearchParams("page=1&page=2")))
      .success,
    false,
  );
});

test("OpenAPI publishes directory query parameters and page response envelopes", () => {
  const document = buildOpenApiDocument();
  const users = document.paths["/api/admin/users"].get;
  assert.deepEqual(
    users.parameters.map((parameter) => parameter.name),
    ["page", "limit", "search", "direction", "status", "sort"],
  );
  assert.ok(
    users.parameters.every((parameter) => parameter.in === "query" && parameter.required === false),
  );
  assert.ok(users.responses["400"]);
  assert.equal(
    document.components.schemas.AuditListSuccess.properties.data.properties.items.type,
    "array",
  );
  assert.equal(
    document.components.schemas.UserDirectorySuccess.properties.data.properties.total.type,
    "integer",
  );
});
