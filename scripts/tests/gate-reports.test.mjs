import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateGateReports } from "../gate-reports.mjs";

for (const [gate, category] of [
  ["test:monitor-collector", "monitor-collector"],
  ["test:deployment", "deployment"],
]) {
  test(`${gate} requires source-bound successful runtime evidence and cleanup`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "operations-gate-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, ".verification", category, "run");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "summary.json");
    const source = { gitSha: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) };
    await assert.rejects(validateGateReports(gate, [], root, source), /one new/);
    const report = { source, status: "passed", cleanupErrors: [] };
    await writeFile(file, JSON.stringify(report));
    await validateGateReports(gate, [file], root, source);
    for (const change of [
      { status: "failed" },
      { cleanupErrors: ["owned_container_remains"] },
      { source: { ...source, sourceSha256: "c".repeat(64) } },
    ]) {
      await writeFile(file, JSON.stringify({ ...report, ...change }));
      await assert.rejects(validateGateReports(gate, [file], root, source));
    }
  });
}

test("runtime gates require their new matching successful report rather than a command log", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gate-reports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".verification/app/run-one");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "result.json");
  const source = { gitSha: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) };
  const buildSha256 = "c".repeat(64);
  const verificationRuns = ["initial", "restored"].map((database, index) => ({
    database,
    status: "passed",
    rateLimitIsolation: "fresh-process",
    smoke: {
      pid: index * 2 + 1,
      buildSha256,
      errorFrames: "passed",
      log: path.join(directory, `${database}.log`),
    },
    browser: { pid: index * 2 + 2, buildSha256 },
  }));
  const files = [file, ...verificationRuns.map((run) => run.smoke.log)];
  for (const log of files.slice(1)) await writeFile(log, "HTTP failure frames retained\n");
  const report = {
    status: "passed",
    mode: "ui",
    production: true,
    browserRuns: 2,
    source,
    cleanupErrors: [],
    buildSha256,
    verificationRuns,
    rateLimitIsolationRestarts: 2,
  };
  await assert.rejects(validateGateReports("test:ui:production", [], root, source), /one new/);
  await writeFile(file, JSON.stringify(report));
  await validateGateReports("test:ui:production", files, root, source);
  for (const change of [
    { status: "failed" },
    { source: { ...source, dirty: true } },
    { browserRuns: 0 },
    { cleanupErrors: ["failed"] },
    { rateLimitIsolationRestarts: 1 },
    { verificationRuns: verificationRuns.slice(0, 1) },
    { buildSha256: "d".repeat(64) },
  ]) {
    await writeFile(file, JSON.stringify({ ...report, ...change }));
    await assert.rejects(validateGateReports("test:ui:production", files, root, source));
  }
  for (const mutate of [
    (run) => {
      run.status = "failed";
    },
    (run) => {
      run.smoke.pid = run.browser.pid;
    },
    (run) => {
      delete run.smoke.pid;
    },
    (run) => {
      run.browser.buildSha256 = "d".repeat(64);
    },
    (run) => {
      delete run.smoke.errorFrames;
    },
    (run) => {
      run.smoke.log = "/tmp/unrelated.log";
    },
  ]) {
    const altered = structuredClone(report);
    mutate(altered.verificationRuns[0]);
    await writeFile(file, JSON.stringify(altered));
    await assert.rejects(validateGateReports("test:ui:production", files, root, source));
  }
  await validateGateReports("typecheck", [], root, source);
});

test("a gate cannot borrow another gate's fresh report or evidence outside its checkout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gate-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, ".verification/verify-one/test-ui");
  const second = path.join(root, ".verification/verify-one/test-ui-production");
  await mkdir(path.join(first, "app/run"), { recursive: true });
  await mkdir(second, { recursive: true });
  const file = path.join(first, "app/run/result.json");
  const source = { gitSha: "a".repeat(40), dirty: false, sourceSha256: "b".repeat(64) };
  await writeFile(
    file,
    JSON.stringify({ source, status: "passed", mode: "ui", production: false, browserRuns: 1 }),
  );
  await validateGateReports("test:ui", [file], root, source, { evidenceRoot: first });
  await assert.rejects(
    validateGateReports("test:ui", [file], root, source, { evidenceRoot: second }),
    /within gate root/,
  );
  await assert.rejects(
    validateGateReports("test:ui", [file], root, source, { evidenceRoot: tmpdir() }),
    /within checkout/,
  );
  await assert.rejects(
    validateGateReports(
      "test:ui",
      [file],
      root,
      { ...source, dirty: true },
      { evidenceRoot: first },
    ),
    /source mismatch/,
  );
});
