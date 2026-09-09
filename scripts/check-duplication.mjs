#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sourceRoots } from "./source-scope.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "node_modules/jscpd/run-jscpd.js");
const output = "artifacts/quality/duplication";

export function validateReport(report) {
  const total = report.statistics.total;
  assert.ok(Number.isInteger(total.sources) && total.sources > 0, "jscpd scanned no source files");
  assert.ok(Number.isInteger(total.tokens) && total.tokens > 0, "jscpd scanned no source tokens");
  assert.ok(Array.isArray(report.duplicates), "jscpd report is missing duplicates");
  assert.equal(total.clones, report.duplicates.length, "jscpd clone count is inconsistent");
  for (const clone of report.duplicates) {
    assert.ok(
      clone.isNew === true || clone.isNew === false,
      "jscpd clone has no baseline classification",
    );
    for (const file of [clone.firstFile, clone.secondFile]) {
      assert.ok(path.isAbsolute(file.name), "jscpd report must use absolute source paths");
      assert.ok(Number.isInteger(file.start) && file.start > 0, "jscpd clone has no source line");
    }
  }
  assert.equal(
    total.newClones,
    report.duplicates.filter((clone) => clone.isNew).length,
    "jscpd new clone count is inconsistent",
  );
  return total;
}

export async function checkDuplication({ cwd = root, update = false } = {}) {
  if (update && process.env.CI)
    throw new Error("Baseline updates are disabled in CI; review accepted clones locally.");
  const config = JSON.parse(await readFile(path.join(cwd, ".jscpd.json"), "utf8"));
  assert.equal(config.output, output, "Keep duplication reports in artifacts/quality/duplication");
  assert.deepEqual(config.reporters, ["json"], "The duplication gate requires the JSON reporter");
  const roots = await sourceRoots(cwd, "duplication");
  assert.ok(Array.isArray(config.path), "No production roots configured");
  assert.deepEqual(
    [...config.path].sort(),
    [...roots].sort(),
    "Duplication paths differ from scripts/source-scope.json",
  );
  const baseline = path.join(cwd, ".jscpd-baseline.json");
  const directory = path.join(cwd, output);
  const reportFile = path.join(directory, "jscpd-report.json");
  const pending = path.join(directory, "baseline.pending.json");
  await mkdir(directory, { recursive: true });
  await rm(reportFile, { force: true });
  let original;
  if (update) {
    await rm(pending, { force: true });
    try {
      await copyFile(baseline, pending);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } else {
    original = await readFile(baseline, "utf8");
  }
  const args = [executable, "--config", ".jscpd.json", "--baseline", update ? pending : baseline];
  args.push(update ? "--update-baseline" : "--fail-on-new-clones=0");
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`jscpd terminated by ${result.signal}`);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const total = validateReport(report);
  if (!update)
    assert.equal(
      await readFile(baseline, "utf8"),
      original,
      "jscpd modified the baseline during a check",
    );
  if (result.status !== 0 || (!update && total.newClones > 0)) {
    throw new Error(
      `Duplication check failed: ${total.newClones} new clones; inspect ${output}/jscpd-report.json and remove the duplication.`,
    );
  }
  if (update) {
    await copyFile(pending, baseline);
    await rm(pending);
  }
  console.log(
    `Duplication ${update ? "baseline updated" : "check passed"}: ${total.sources} files, ${total.clones} clones, ${total.newClones} new.`,
  );
  return total;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--update-baseline")) {
    console.error("Usage: node scripts/check-duplication.mjs [--update-baseline]");
    process.exitCode = 1;
  } else {
    checkDuplication({ update: args[0] === "--update-baseline" }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
