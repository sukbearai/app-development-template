import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { PublicationError, publicationFailure } from "../release-diagnostics.mjs";

test("publication diagnostics retain assertion stage and error code", () => {
  const error = new Error("Scanner image differs from tested archive");
  error.code = "ERR_ASSERTION";
  assert.deepEqual(publicationFailure(new PublicationError("security_scan", error)), {
    stage: "security_scan",
    code: "ERR_ASSERTION",
    exitCode: null,
    signal: null,
    message: error.message,
    stderr: null,
  });
});
test("failed subprocess diagnostics omit command arguments and redact bounded stderr", () => {
  let failure;
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stderr.write('denied Bearer upstream-secret https://user:password@example.test/v2?token=query-secret env-secret ghp_testsecret\\n' + 'x'.repeat(6000)); process.exit(7)`,
        "secret-command-argument",
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    failure = error;
  }
  const result = publicationFailure(new PublicationError("registry_web", failure), {
    GH_TOKEN: "env-secret",
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stage, "registry_web");
  assert.match(result.stderr, /denied/);
  assert.ok(result.stderr.length <= 4096);
  assert.doesNotMatch(
    JSON.stringify(result),
    /upstream-secret|query-secret|env-secret|user:password|ghp_testsecret|secret-command-argument/,
  );
});
test("publish CLI emits actionable diagnostics in JSON and human mode", () => {
  for (const json of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-publish.mjs",
        "--candidate",
        "artifacts/absent-candidate.json",
        "--evidence",
        "artifacts/absent-index.json",
        "--output",
        "artifacts/release",
        "--repo",
        "example/pstack",
        ...(json ? ["--json"] : []),
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const diagnostic = json ? JSON.parse(result.stdout).data : JSON.parse(result.stderr);
    assert.equal(diagnostic.stage, "candidate_verification");
    assert.equal(diagnostic.code, "ENOENT");
  }
});
