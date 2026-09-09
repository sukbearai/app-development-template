import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeToWebRequest, sendWebResponse } from "vinext/server/prod-server";
import { withAccessLog } from "@pstack/server/logger";
import { ApiError } from "@pstack/server/api-response";

function request(address, agent, method) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      address + (method === "POST" ? "/api/uploads" : "/api/hello"),
      {
        method,
        agent,
        headers:
          method === "POST"
            ? { "content-length": 262144, "content-type": "multipart/form-data; boundary=fixture" }
            : {},
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.setTimeout(1000, () => outgoing.destroy(new Error("followup transport timed out")));
    outgoing.end(method === "POST" ? Buffer.alloc(262144) : undefined);
  });
}

for (const [status, code] of [
  [401, "UNAUTHORIZED"],
  [413, "UPLOAD_TOO_LARGE"],
  [503, "UPLOAD_BUSY"],
  [200, null],
]) {
  test(`vinext Node transport keeps the next request usable after upload HTTP ${status}`, async () => {
    let connections = 0;
    const server = http.createServer(async (incoming, outgoing) => {
      const webRequest = nodeToWebRequest(incoming);
      const response = await withAccessLog(webRequest, "trace-transport", async () => {
        if (incoming.method === "POST") {
          if (code) throw new ApiError(status, code, "上传请求被拒绝");
          const bytes = await webRequest.arrayBuffer();
          return Response.json({
            traceId: "trace-transport",
            data: {
              id: "file-fixture",
              fileName: "fixture.txt",
              mimeType: "text/plain",
              sizeBytes: bytes.byteLength,
              storageKey: "upload-fixture",
              uploadedBy: "fixture-user",
              uploadedAt: new Date().toISOString(),
            },
          });
        }
        return Response.json({ message: "Hello from vinext" });
      });
      await sendWebResponse(response, incoming, outgoing, false);
    });
    server.on("connection", () => connections++);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = `http://127.0.0.1:${server.address().port}`;
      const rejected = await request(address, agent, "POST");
      assert.equal(rejected.status, status);
      if (code) assert.equal(JSON.parse(rejected.body).error.code, code);
      else assert.equal(JSON.parse(rejected.body).data.sizeBytes, 262144);
      const next = await request(address, agent, "GET");
      assert.equal(next.status, 200);
      assert.equal(JSON.parse(next.body).message, "Hello from vinext");
      assert.equal(connections, code ? 2 : 1);
      assert.equal(rejected.headers.connection, code ? "close" : "keep-alive");
    } finally {
      agent.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
