#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSha256, processIdentity, sourceSha256 } from "./identity.mjs";

const root = realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)));
const production = process.env.PSTACK_VERIFY_MODE === "production";
const ownerPath = production
  ? process.env.PSTACK_VERIFY_OWNER
  : `${root}/apps/web/.vinext/dev/lock.json`;
assert.ok(ownerPath, "Production verification requires an ownership record");
const lock = JSON.parse(readFileSync(ownerPath, "utf8"));
const port = Number(process.env.PSTACK_VERIFY_PORT || 4173);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid verification port");
assert.ok(Number.isInteger(lock.pid) && lock.pid > 0, "Invalid vinext owner PID");
if (production) {
  assert.equal(lock.mode, "production");
  assert.equal(lock.root, root);
  assert.equal(lock.baseURL, `http://127.0.0.1:${port}`);
  assert.equal(
    lock.startedAt,
    Number(process.env.PSTACK_VERIFY_STARTED_MS),
    "Owner belongs to another run",
  );
  assert.deepEqual(
    processIdentity(lock.pid),
    { ppid: lock.harnessPid, pgid: lock.pid, processStarted: lock.processStarted },
    "Production child identity changed",
  );
  assert.equal(lock.pgid, lock.pid);
  let ancestor = process.pid;
  while (ancestor > 1 && ancestor !== lock.harnessPid) ancestor = processIdentity(ancestor).ppid;
  assert.equal(
    ancestor,
    lock.harnessPid,
    "Doctor must run under the harness that owns this server",
  );
  const cwd = execFileSync("lsof", ["-a", "-p", String(lock.pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  assert.ok(
    cwd.split("\n").includes(`n${root}/apps/web`),
    "Production child belongs to another application root",
  );
  assert.equal(sourceSha256(root), lock.sourceSha256, "Source changed after production build");
  assert.equal(buildSha256(root), lock.buildSha256, "Production build changed after launch");
}
assert.equal(lock.cwd, `${root}/apps/web`, "Lock belongs to another checkout");
assert.equal(lock.port, port, "vinext moved to a different port");
assert.equal(lock.hostname, "127.0.0.1");
if (process.env.PSTACK_VERIFY_STARTED_MS) {
  assert.ok(
    lock.startedAt >= Number(process.env.PSTACK_VERIFY_STARTED_MS),
    "Server predates this verification run",
  );
}
process.kill(lock.pid, 0);
const listeners = execFileSync("lsof", ["-nP", "-a", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
  encoding: "utf8",
})
  .trim()
  .split(/\s+/);
assert.deepEqual(
  [...new Set(listeners)],
  [String(lock.pid)],
  "The owner must exclusively own the listening port",
);
const response = await fetch(`http://127.0.0.1:${port}/api/hello`, {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type") || "", /application\/json/);
assert.deepEqual(await response.json(), { message: "Hello from vinext" });
const pkg = JSON.parse(readFileSync(`${root}/apps/web/package.json`, "utf8"));
assert.equal(pkg.name, "@pstack/web");
console.log(
  JSON.stringify(
    {
      status: "ready",
      mode: production ? "production" : "development",
      root,
      lock,
      node: process.version,
      vinext: pkg.dependencies.vinext,
      baseURL: `http://127.0.0.1:${port}`,
    },
    null,
    2,
  ),
);
