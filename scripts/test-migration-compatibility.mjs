#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { dockerCommand } from "./deployment-command.mjs";
import { runRollbackDrill } from "./rollback-drill-runtime.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    [
      "previous-web",
      "previous-worker",
      "candidate-web",
      "candidate-worker",
      "context",
      "output",
    ].map((name) => [name, { type: "string" }]),
  ),
});
for (const name of [
  "previous-web",
  "previous-worker",
  "candidate-web",
  "candidate-worker",
  "context",
  "output",
])
  assert.ok(values[name], `--${name} is required`);
const releases = {};
for (const version of ["previous", "candidate"]) {
  const images = {};
  for (const role of ["web", "worker"]) {
    const [image] = JSON.parse(
      await dockerCommand(
        ["--context", values.context, "image", "inspect", values[`${version}-${role}`]],
        process.env,
      ),
    );
    images[role] = {
      id: image.Id,
      reference: image.Id,
      platform: `${image.Os}/${image.Architecture}`,
    };
  }
  releases[version] = { images };
}
assert.equal(releases.previous.images.web.platform, releases.candidate.images.web.platform);
const report = {
  schemaVersion: 2,
  status: "failed",
  images: releases,
  checks: [],
  cleanupErrors: [],
};
try {
  await runRollbackDrill(releases.previous, releases.candidate, values.context, report);
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}
assert.equal(report.status, "passed", "Migration compatibility drill failed; inspect the report");
