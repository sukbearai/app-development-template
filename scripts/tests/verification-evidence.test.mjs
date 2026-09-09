import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sourceIdentity,
  createEvidenceRun,
  evidenceReference,
  writeEvidenceIndex,
  verifyEvidence,
} from "../verification-evidence.mjs";
import { commandResult, commandExitCode, runLogged } from "../engineering-command.mjs";
import { sourceSha256 } from "../../.agents/skills/verify-pstack-x/scripts/identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(root, ".gitignore"), "artifacts/\n");
  await writeFile(path.join(root, "source.txt"), "original\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
  return root;
}
test("source identity includes dirty untracked files and tracked deletion", async (t) => {
  const root = await fixture(t);
  const before = await sourceIdentity(root);
  assert.equal(before.dirty, false);
  assert.equal(before.sourceSha256, sourceSha256(root));
  await writeFile(path.join(root, "new.txt"), "untracked");
  const after = await sourceIdentity(root);
  assert.equal(after.dirty, true);
  assert.notEqual(after.sourceSha256, before.sourceSha256);
  await rm(path.join(root, "source.txt"));
  assert.notEqual((await sourceIdentity(root)).sourceSha256, after.sourceSha256);
});
test("evidence verifies actual bytes and rejects tampering or another source", async (t) => {
  const root = await fixture(t);
  const run = await createEvidenceRun(root);
  const log = path.join(run.output, "check.log");
  await writeFile(log, "actual proof");
  const check = {
    name: "unit",
    status: "passed",
    startedAt: run.startedAt,
    finishedAt: run.startedAt,
    durationMs: 0,
    evidence: [await evidenceReference(root, log)],
  };
  const file = await writeEvidenceIndex(root, run, [check], "passed");
  assert.equal((await verifyEvidence(file, root, run.source)).checks[0].name, "unit");
  await assert.rejects(
    verifyEvidence(file, root, { ...run.source, dirty: true }),
    /source mismatch/,
  );
  await writeFile(log, "changed");
  await assert.rejects(verifyEvidence(file, root), /content mismatch/);
  await rm(log);
  await assert.rejects(verifyEvidence(file, root), /ENOENT/);
});
test("not-run and failed checks cannot form a successful index; symlink escape is refused", async (t) => {
  const root = await fixture(t);
  const run = await createEvidenceRun(root);
  const log = path.join(run.output, "skip.log");
  await writeFile(log, "not run");
  const check = {
    name: "unit",
    status: "not-run",
    startedAt: run.startedAt,
    finishedAt: run.startedAt,
    durationMs: 0,
    evidence: [await evidenceReference(root, log)],
  };
  await assert.rejects(writeEvidenceIndex(root, run, [check], "passed"), /Incomplete evidence/);
  await symlink(tmpdir(), path.join(run.output, "outside"));
  await assert.rejects(
    evidenceReference(root, path.join(run.output, "outside")),
    /within its root/,
  );
});
test("logged command invokes actual process, preserves failure, and returns stable envelope", async (t) => {
  const root = await fixture(t);
  const result = await runLogged({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("proof"); process.exitCode=7'],
    cwd: root,
    logFile: path.join(root, "run.log"),
  });
  assert.equal(result.code, 7);
  assert.equal(commandExitCode("invalid"), 2);
  assert.equal(
    commandResult({
      command: "test",
      runId: "fixture",
      status: "failed",
      errorCode: "check_failed",
    }).schemaVersion,
    1,
  );
  assert.throws(() => commandExitCode("unknown"));
});
test("unavailable log prevents the child from starting", async (t) => {
  const root = await fixture(t);
  const logFile = path.join(root, "existing.log");
  await writeFile(logFile, "keep");
  const marker = path.join(root, "marker");
  await assert.rejects(
    runLogged({
      command: process.execPath,
      args: ["-e", 'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
      cwd: root,
      logFile,
    }),
    /EEXIST/,
  );
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(marker), /ENOENT/);
});
test("interrupted child that ignores SIGTERM is killed within the explicit grace", async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, "ready");
  const controller = new AbortController();
  const { access } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const run = runLogged({
    command: process.execPath,
    args: [
      "-e",
      'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)',
      marker,
    ],
    cwd: root,
    logFile: path.join(root, "ignored-stop.log"),
    signal: controller.signal,
    stopGraceMs: 50,
  });
  for (let attempts = 0; ; attempts++) {
    try {
      await access(marker);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || attempts > 100) throw error;
      await delay(10);
    }
  }
  controller.abort();
  const result = await run;
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.interrupted, true);
});
