import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  capacityFailure,
  readCapacityResponse,
  summarizeFailures,
} from "../capacity-diagnostics.mjs";
import { assessCapacityResponse } from "../capacity-summary.mjs";

test("diagnostics retain allowlisted names/codes without raw error data", () => {
  const error = new TypeError("secret https://user:password@database.invalid", {
    cause: { code: "UND_ERR_SOCKET", token: "secret" },
  });
  error.code = "ECONNRESET";
  assert.deepEqual(capacityFailure("request", error), {
    stage: "request",
    name: "TypeError",
    code: "ECONNRESET",
    causeCode: "UND_ERR_SOCKET",
  });
  const sensitive = {
    name: "secret-name",
    code: "secret-code",
    cause: { code: "secret-cause" },
    message: "secret-message",
  };
  assert.deepEqual(capacityFailure("response_body", sensitive), {
    stage: "response_body",
    name: "OtherError",
    code: null,
    causeCode: null,
  });
  assert.doesNotMatch(JSON.stringify(capacityFailure("request", error)), /secret|password|https/);
});

test("body decoding faults and malformed success contracts have distinct safe stages", async () => {
  const broken = await readCapacityResponse(new Response("{broken", { status: 200 }));
  assert.equal(broken.diagnostic.stage, "response_body");
  assert.equal(broken.diagnostic.name, "SyntaxError");
  const badContract = assessCapacityResponse("read", new Response(null, { status: 200 }), {
    traceId: "trace_test",
    data: 123,
  });
  assert.equal(badContract.outcome, "failed");
  assert.equal(badContract.diagnostic.stage, "response_contract");
  assert.equal(badContract.diagnostic.name, "ZodError");
  const wrongStatus = assessCapacityResponse("upload", new Response(null, { status: 503 }), {
    traceId: "trace_test",
    error: { code: "UNAVAILABLE", message: "private-detail" },
  });
  assert.equal(wrongStatus.outcome, "failed");
  assert.equal(wrongStatus.diagnostic.stage, "response_status");
  assert.doesNotMatch(JSON.stringify(wrongStatus), /private-detail/);
});

test("a real disconnected HTTP response body retains transport cause without raw errors", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "500" });
    response.write('{"data":');
    setTimeout(() => response.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      signal: AbortSignal.timeout(1000),
    });
    const result = await readCapacityResponse(response);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.diagnostic, {
      stage: "response_body",
      name: "TypeError",
      code: null,
      causeCode: "UND_ERR_SOCKET",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("failure details are bounded while status/outcome counts include every request", () => {
  const diagnostic = capacityFailure(
    "request",
    new DOMException("private-message", "TimeoutError"),
  );
  const observations = Array.from({ length: 30 }, (_, index) => ({
    operation: "upload",
    index,
    status: null,
    outcome: "failed",
    durationMs: 1000,
    diagnostic,
  }));
  observations.push({
    operation: "upload",
    index: 30,
    status: 503,
    outcome: "upload_busy",
    durationMs: 1,
  });
  const summary = summarizeFailures(observations);
  assert.equal(summary.failureObservations.length, 20);
  assert.equal(summary.omittedFailures, 10);
  assert.deepEqual(summary.responses, [
    { status: null, outcome: "failed", count: 30 },
    { status: 503, outcome: "upload_busy", count: 1 },
  ]);
  assert.equal(summary.failureObservations[19].index, 19);
  assert.doesNotMatch(JSON.stringify(summary), /private-message/);
});
