import test from "node:test";
import assert from "node:assert/strict";
import { userPageQuerySchema, userDirectorySchema } from "../../src/modules/identity/contracts.ts";
import { auditPageQuerySchema, auditPageSchema } from "../../src/modules/audit/contracts.ts";
import { readPageSearchParams } from "../../src/transport.ts";
import { jsonSchema } from "../../src/openapi.ts";

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

test("directory schemas retain optional inputs and complete page outputs for tRPC", () => {
  const users = jsonSchema(userPageQuerySchema, "input");
  assert.deepEqual(Object.keys(users.properties), [
    "page",
    "limit",
    "search",
    "direction",
    "status",
    "sort",
  ]);
  assert.equal(users.required?.length ?? 0, 0);
  const audit = jsonSchema(auditPageSchema, "output");
  const directory = jsonSchema(userDirectorySchema, "output");
  assert.equal(audit.properties.items.type, "array");
  assert.equal(directory.properties.total.type, "integer");
  assert.equal(auditPageSchema.safeParse({}).success, false);
  assert.equal(userDirectorySchema.safeParse({}).success, false);
});
