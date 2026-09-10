import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiRequestError } from "../../lib/api-client.ts";
import { setSubmissionError } from "../../lib/form-errors.ts";

test("server validation assigns only registered fields and focuses the first field", () => {
  const assigned = [];
  const error = new ApiRequestError("Validation failed", {
    kind: "http",
    status: 400,
    code: "VALIDATION_FAILED",
    traceId: "trace-validation",
    details: {
      issues: [
        { path: ["unexpected"], message: "ignore" },
        { path: ["account"], message: "账号已存在" },
        { path: ["account"], message: "second account error" },
        { path: ["roleIds", 0], message: "角色不可用" },
      ],
    },
  });
  setSubmissionError(error, (...args) => assigned.push(args), ["account", "roleIds"]);
  assert.deepEqual(assigned, [
    ["root", { message: "Validation failed" }],
    ["account", { type: "server", message: "账号已存在" }, { shouldFocus: true }],
    ["roleIds", { type: "server", message: "角色不可用" }, { shouldFocus: false }],
  ]);
});

test("malformed or unrelated HTTP details remain a form-level error", () => {
  for (const error of [
    new ApiRequestError("服务繁忙", {
      kind: "http",
      status: 503,
      code: "UNAVAILABLE",
      details: { issues: [{ path: ["account"], message: "not validation" }] },
    }),
    new ApiRequestError("校验失败", {
      kind: "http",
      status: 400,
      code: "VALIDATION_FAILED",
      details: { issues: [{ path: {}, message: "invalid" }] },
    }),
    new Error("连接中断"),
  ]) {
    const assigned = [];
    setSubmissionError(error, (...args) => assigned.push(args), ["account"]);
    assert.deepEqual(assigned, [["root", { message: error.message }]]);
  }
});
