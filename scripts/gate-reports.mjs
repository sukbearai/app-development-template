import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const reports = {
  "test:e2e": { directory: "app", file: "result.json", mode: "api", production: false },
  "test:ui": { directory: "app", file: "result.json", mode: "ui", production: false },
  "test:ui:production": { directory: "app", file: "result.json", mode: "ui", production: true },
  "test:capacity": { directory: "app", file: "result.json", mode: "capacity", production: true },
  "test:containers": { directory: "containers", file: "summary.json" },
  "test:async-recovery": { directory: "async-recovery", file: "summary.json" },
  "test:kafka-security": { directory: "kafka-security", file: "summary.json" },
  "test:monitor-collector": { directory: "monitor-collector", file: "summary.json" },
  "test:deployment": { directory: "deployment", file: "summary.json" },
  "test:deployment:slots": { directory: "deployment-slots", file: "summary.json" },
};
export async function validateGateReports(
  gate,
  files,
  root,
  source,
  { evidenceRoot = path.join(root, ".verification") } = {},
) {
  const directory = await realpath(evidenceRoot);
  const checkout = await realpath(root);
  const within = (base, target) => {
    const relative = path.relative(base, target);
    return (
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  assert.ok(within(checkout, directory), "Evidence root must stay within checkout");
  for (const file of files)
    assert.ok(within(directory, await realpath(file)), "Evidence must stay within gate root");
  const expected = reports[gate];
  if (!expected) return;
  const matches = files.filter(
    (file) =>
      path
        .relative(evidenceRoot, file)
        .split(path.sep)
        .join("/")
        .startsWith(`${expected.directory}/`) && path.basename(file) === expected.file,
  );
  assert.equal(matches.length, 1, `Expected one new ${gate} report`);
  const report = JSON.parse(await readFile(matches[0], "utf8"));
  assert.equal(report.status, "passed", `${gate} report failed`);
  assert.ok(!report.cleanupErrors?.length && !report.cleanupError, `${gate} cleanup failed`);
  assert.deepEqual(report.source, source, `${gate} source mismatch`);
  if (expected.mode) {
    assert.equal(report.mode, expected.mode, "Wrong verification mode");
    assert.equal(report.production, expected.production, "Wrong production surface");
  }
  if (expected.mode === "ui")
    assert.equal(report.browserRuns, expected.production ? 2 : 1, "Missing browser runs");
  if (expected.mode === "ui" && expected.production) {
    assert.equal(report.rateLimitIsolationRestarts, 2, "Missing rate-limit isolation restarts");
    assert.match(report.buildSha256, /^[a-f0-9]{64}$/, "Missing production build identity");
    assert.deepEqual(
      report.verificationRuns?.map((run) => run.database),
      ["initial", "restored"],
      "Missing production verification rounds",
    );
    for (const run of report.verificationRuns) {
      assert.equal(run.status, "passed", "Production round failed");
      assert.equal(run.rateLimitIsolation, "fresh-process", "Missing fresh browser process");
      assert.ok(Number.isSafeInteger(run.smoke?.pid) && run.smoke.pid > 0, "Missing smoke PID");
      assert.ok(
        Number.isSafeInteger(run.browser?.pid) && run.browser.pid > 0,
        "Missing browser PID",
      );
      assert.notEqual(run.smoke.pid, run.browser.pid, "Smoke and browser shared a process");
      assert.equal(run.smoke.buildSha256, report.buildSha256, "Smoke build mismatch");
      assert.equal(run.browser.buildSha256, report.buildSha256, "Browser build mismatch");
      assert.equal(run.smoke.errorFrames, "passed", "Missing production error frames");
      assert.ok(files.includes(run.smoke.log), "Missing smoke log evidence");
    }
  }
  if (expected.mode === "capacity") {
    const capacityFile = path.join(path.dirname(matches[0]), "capacity.json");
    assert.ok(files.includes(capacityFile), "Missing capacity evidence");
    const capacity = JSON.parse(await readFile(capacityFile, "utf8"));
    assert.equal(capacity.status, "passed", "Capacity report failed");
    assert.deepEqual(capacity.comparison.source, source, "Capacity source mismatch");
  }
}
