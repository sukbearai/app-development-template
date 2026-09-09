import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNever,
  asyncTaskEventMessageSchema,
  kafkaConsumerOffsetSchema,
  loginRequestSchema,
  telemetryRequestSchema,
} from "../src/index.ts";

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

test("async message contracts bound indexed identifiers by UTF-8 bytes", () => {
  const input = { eventId: "event", eventType: "demo.echo", traceId: "trace", payload: {} };
  for (const field of ["eventId", "eventType", "traceId", "taskId", "idempotencyKey"]) {
    assert.equal(
      asyncTaskEventMessageSchema.safeParse({ ...input, [field]: "😀".repeat(500) }).success,
      true,
    );
    assert.equal(
      asyncTaskEventMessageSchema.safeParse({ ...input, [field]: "😀".repeat(501) }).success,
      false,
    );
    assert.equal(
      asyncTaskEventMessageSchema.safeParse({ ...input, [field]: "x".repeat(2001) }).success,
      false,
    );
  }
});

test("Kafka metadata contracts keep quarantine composite indexes bounded without rewriting group identity", () => {
  const offset = { topic: "app.tasks", partition: 0, offset: "0", consumerGroup: " group " };
  assert.equal(kafkaConsumerOffsetSchema.parse(offset).consumerGroup, " group ");
  assert.equal(
    kafkaConsumerOffsetSchema.safeParse({ ...offset, consumerGroup: "😀".repeat(64) }).success,
    true,
  );
  for (const extra of [
    { consumerGroup: "😀".repeat(65) },
    { consumerGroup: "x\u0000" },
    { consumerGroup: "x\ud800" },
    { topic: "x".repeat(250) },
    { offset: "x" },
    { offset: "1".repeat(20) },
  ])
    assert.equal(kafkaConsumerOffsetSchema.safeParse({ ...offset, ...extra }).success, false);
});
