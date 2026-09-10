import test from "node:test";
import assert from "node:assert/strict";
import { filePageQuerySchema } from "../../src/modules/uploads/contracts.ts";

test("file cursor is bounded and preserves exact database timestamp precision", () => {
  assert.deepEqual(filePageQuerySchema.parse({}), { limit: 100 });
  const cursor = { uploadedAt: "2026-09-08T00:00:00.000001Z", id: "file_123" };
  assert.deepEqual(filePageQuerySchema.parse({ limit: "25", cursor: JSON.stringify(cursor) }), {
    limit: 25,
    cursor,
  });
  for (const value of [
    "",
    "not-json",
    "null",
    "[]",
    "x".repeat(1025),
    JSON.stringify({ ...cursor, uploadedAt: "2026-02-30T00:00:00.000001Z" }),
    JSON.stringify({ ...cursor, id: "" }),
    JSON.stringify({ ...cursor, id: "\u0000" }),
    JSON.stringify({ ...cursor, id: "\ud800" }),
    JSON.stringify({ ...cursor, id: "x".repeat(257) }),
    JSON.stringify({ ...cursor, uploadedAt: "infinity" }),
    JSON.stringify({ ...cursor, uploadedAt: "0000-01-01T00:00:00.000001Z" }),
    JSON.stringify({ ...cursor, uploadedAt: "2026-09-08T00:00:00.001Z" }),
  ]) {
    assert.equal(filePageQuerySchema.safeParse({ cursor: value }).success, false);
  }
  for (const limit of ["0", "101", "2.5", "Infinity", ["1", "2"], ["1"]])
    assert.equal(filePageQuerySchema.safeParse({ limit }).success, false);
  assert.equal(filePageQuerySchema.safeParse({ cursor: ["x", "y"] }).success, false);
});
