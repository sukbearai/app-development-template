import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNever, loginRequestSchema, telemetryRequestSchema } from "../src/index.ts";

test("assertNever throws for unreachable values", () => {
  assert.throws(() => assertNever("unexpected"), /Unexpected value/);
});

test("shared zod schemas validate request contracts", () => {
  assert.deepEqual(loginRequestSchema.parse({ account: " admin ", password: "secret" }), {
    account: "admin",
    password: "secret",
  });
  assert.throws(() => loginRequestSchema.parse({ account: "", password: "secret" }));

  assert.deepEqual(telemetryRequestSchema.parse({ event: "page.view" }), {
    event: "page.view",
    payload: {},
  });
});
