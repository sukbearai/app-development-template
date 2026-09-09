import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("collector command failures always retain failed evidence and cleanup failures cannot pass", async (t) => {
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "monitor-collector-report-repository-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    "scripts/test-monitor-collector.mjs",
    "scripts/verification-evidence.mjs",
    "scripts/verification-output.mjs",
    "scripts/toolchain-lock.json",
    "deploy/otel-collector.yaml",
  ]) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(checkout, file), target);
  }
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.verification/\n");
  await symlink(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "dir");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Monitor fixture",
    "-c",
    "user.email=monitor-fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "Create isolated collector fixture",
  );
  const bin = await mkdtemp(path.join(tmpdir(), "monitor-collector-failed-docker-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const cleanupExit of [0, 62]) {
    const output = path.join(root, ".verification", `monitor-report-test-${randomUUID()}`);
    t.after(() => rm(output, { recursive: true, force: true }));
    await writeFile(
      path.join(bin, "docker"),
      `#!/bin/sh\ncase "$1" in\nrun) exit 61;;\nrm) exit ${cleanupExit};;\n*) exit 63;;\nesac\n`,
      { mode: 0o700 },
    );
    const child = spawn(process.execPath, ["scripts/test-monitor-collector.mjs"], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PSTACK_VERIFICATION_ROOT: output },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 1);
    assert.doesNotMatch(stdout, /verification passed/);
    const runs = await readdir(path.join(output, "monitor-collector"));
    assert.equal(runs.length, 1);
    const summary = JSON.parse(
      await readFile(path.join(output, "monitor-collector", runs[0], "summary.json"), "utf8"),
    );
    assert.equal(summary.status, "failed");
    assert.deepEqual(summary.checks, []);
    assert.ok(summary.error);
    assert.match(summary.source.sourceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(summary.sourceAtEnd, summary.source);
    assert.equal(summary.cleanupErrors.length, cleanupExit === 0 ? 0 : 1);
    if (cleanupExit) assert.match(summary.cleanupErrors[0], /^container_removal_failed:/);
  }
});
