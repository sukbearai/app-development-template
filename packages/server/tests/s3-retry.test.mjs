import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("a disconnected PUT remains uncertain without an acknowledged retry", async () => {
  let attempts = 0;
  let objectExists = false;
  let releaseFirst, markSettled;
  const settled = new Promise((resolve) => {
    markSettled = resolve;
  });
  const pending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) {
      /* Receive the complete body before losing the response. */
    }
    if (request.method === "PUT") {
      attempts++;
      if (attempts === 1) {
        request.socket.destroy();
        await pending;
        objectExists = true;
        markSettled();
        return;
      }
      objectExists = true;
      response.writeHead(200, { ETag: '"test-etag"' });
      response.end();
    } else {
      response.writeHead(405);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    NODE_ENV: "test",
    OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    OBJECT_STORAGE_ACCESS_KEY: "isolated-test",
    OBJECT_STORAGE_SECRET_KEY: "isolated-test",
    OBJECT_STORAGE_BUCKET: "test-bucket",
    OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
  });
  const { putS3Object, closeS3 } = await import("../src/s3-client.ts");
  try {
    await assert.rejects(
      putS3Object({ key: "upload_1234", bytes: Buffer.from("sample"), contentType: "text/plain" }),
    );
    assert.equal(attempts, 1);
    assert.equal(objectExists, false);
    releaseFirst();
    await settled;
    assert.equal(
      objectExists,
      true,
      "a rejected request may still finish remotely and needs reconciliation evidence",
    );
  } finally {
    releaseFirst();
    closeS3();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
