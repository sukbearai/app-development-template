#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanCandidate, scannerUser } from "./release-security.mjs";
import { toolchain } from "./toolchain.mjs";

// Named volumes exercise Linux ownership even when Docker runs on macOS.
const volume = `pstack-scanner-permissions-${randomUUID()}`;
const root = await mkdtemp(path.join(os.tmpdir(), "pstack-scanner-permissions-"));
const stopped = new Error("Captured scanner invocation");
let scannerArgs;
try {
  await assert.rejects(
    scanCandidate(root, {}, path.join(root, "scan"), (program, args) => {
      assert.equal(program, "docker");
      scannerArgs = args;
      throw stopped;
    }),
    (error) => error === stopped,
  );
  const userIndex = scannerArgs.indexOf("--user");
  assert.ok(userIndex >= 0, "Scanner must explicitly run as the host user");
  const user = scannerArgs[userIndex + 1];
  assert.equal(user, scannerUser());
  const run = (uid, source) =>
    spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        uid,
        "--mount",
        `type=volume,src=${volume},dst=/evidence`,
        toolchain.images.node,
        "node",
        "--input-type=module",
        "-e",
        source,
      ],
      { encoding: "utf8", timeout: 120000 },
    );
  const ok = (result) => assert.equal(result.status, 0, result.stderr || result.error?.message);
  execFileSync("docker", ["volume", "create", volume], { stdio: "pipe" });
  // Use a non-root runner even when this test itself was invoked by root.
  const reader = user === "0:0" ? "12345:12345" : user;
  const [uid, gid] = reader.split(":").map(Number);
  ok(
    run(
      "0:0",
      `import fs from 'node:fs';
    for (const name of ['old', 'fixed']) {
      fs.mkdirSync('/evidence/' + name, { mode: 0o700 });
      fs.chownSync('/evidence/' + name, ${uid}, ${gid});
    }`,
    ),
  );
  const write = (name) => `import fs from 'node:fs';
    fs.mkdirSync('/evidence/${name}/trivy-cache/fanal', { recursive: true, mode: 0o700 });
    fs.writeFileSync('/evidence/${name}/trivy-cache/fanal/report.json', '{}', { mode: 0o600 });`;
  const read = (name) => `import fs from 'node:fs';
    for (const file of fs.readdirSync('/evidence/${name}', { recursive: true, withFileTypes: true })) {
      if (file.isFile()) fs.readFileSync(file.parentPath + '/' + file.name);
    }`;
  ok(run("0:0", write("old")));
  const blocked = run(reader, read("old"));
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /EACCES/);
  // Apply the actual scanCandidate user argument, substituting only a root test host.
  ok(run(user === "0:0" ? reader : user, write("fixed")));
  ok(run(reader, read("fixed")));
  process.stdout.write("Linux scanner permissions: root cache rejected; runner cache readable\n");
} finally {
  execFileSync("docker", ["volume", "rm", "--force", volume], { stdio: "pipe" });
  await rm(root, { recursive: true, force: true });
}
