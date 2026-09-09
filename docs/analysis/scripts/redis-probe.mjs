import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import { resolve } from "node:path";

const template = process.argv[2];
if (!template) throw new Error("Pass the template repository path");
const source = await readFile(resolve(template, "apps/web/lib/redis-client.ts"), "utf8");
const code = stripTypeScriptTypes(source);
const { redisIncr } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const results = [];

for (const scenario of [
  { name: "plain", credentials: "", path: "", reply: ":1\r\n", rejects: false },
  { name: "select", credentials: "", path: "/0", reply: "+OK\r\n:1\r\n", rejects: true },
  { name: "auth", credentials: ":probe-only@", path: "", reply: "+OK\r\n:1\r\n", rejects: true },
]) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => socket.end(scenario.reply));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Assert the TCP address variant returned by the ephemeral listener before reading its port.
    assert.ok(address && typeof address === "object");
    const url = `redis://${scenario.credentials}127.0.0.1:${address.port}${scenario.path}`;
    if (scenario.rejects) {
      await assert.rejects(redisIncr(url, "probe"), /Unexpected Redis reply/);
    } else {
      assert.equal(await redisIncr(url, "probe"), 1);
    }
    results.push({ scenario: scenario.name, validReplyRejected: scenario.rejects });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

console.log(
  JSON.stringify(
    {
      results,
      boundary:
        "Original Redis client with loopback TCP reply fixtures; no Redis server, authentication, login, or database integration.",
    },
    null,
    2,
  ),
);
