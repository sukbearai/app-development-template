import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { verifyCapacityOverload } from "../capacity-overload.mjs";

async function admissionServer(operation) {
  let active = 0;
  let rejectedTotal = 0;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (active === 2) {
      rejectedTotal++;
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(
        JSON.stringify({
          traceId: "trace_capacity_test",
          error: { code: "UPLOAD_BUSY", message: "Upload slots occupied" },
        }),
      );
      return;
    }
    active++;
    request.on("close", () => {
      active--;
    });
    request.resume();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sample = async () => ({ uploads: { active, limit: 2, rejectedTotal } });
  const upload = async () => {
    const response = await fetch(`${base}/api/uploads`, {
      method: "POST",
      body: "x",
      signal: AbortSignal.timeout(1000),
    });
    return { response, payload: await response.json() };
  };
  try {
    await operation(
      { base, token: "test-only", sample, upload, signal: AbortSignal.timeout(3000) },
      () => active,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("overload probe holds complete admission, verifies rejection, and releases requests", async () => {
  await admissionServer(async (input, active) => {
    assert.deepEqual(await verifyCapacityOverload(input), {
      status: "passed",
      heldRequests: 2,
      rejectedRequests: 1,
      activeAfterRelease: 0,
    });
    assert.equal(active(), 0);
  });
});

test("overload probe closes held sockets when rejection validation fails", async () => {
  await admissionServer(async (input, active) => {
    input.upload = async () => ({ response: new Response(null, { status: 500 }), payload: null });
    await assert.rejects(verifyCapacityOverload(input), /must reject/);
    const deadline = Date.now() + 1000;
    while (active() > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(active(), 0);
  });
});

test("interrupted probe issues no new request", async () => {
  await admissionServer(async (input, active) => {
    input.signal = AbortSignal.abort();
    await assert.rejects(verifyCapacityOverload(input), { name: "AbortError" });
    assert.equal(active(), 0);
  });
});
