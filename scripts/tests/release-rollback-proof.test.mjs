import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRollbackProof } from "../release-rollback-proof.mjs";
import { verifyRelease } from "../release-manifest.mjs";
import {
  rollbackChecks,
  migrationChecks,
  rollbackIdentity,
  verifyRollbackProof,
} from "../rollback-proof.mjs";
import { expectedApplied } from "../migration-compatibility.mjs";
import { migrationLedgerPath } from "../release-manifest.mjs";
import { sha256 } from "../verification-evidence.mjs";
import { releaseFixture } from "./release-fixture.mjs";

test("rollback producer verifies separate bundles with colliding relative paths without rewriting predecessor", async (t) => {
  const candidate = await releaseFixture(t);
  const previous = await releaseFixture(t);
  previous.release.version = "0.0.9";
  previous.release.tag = "v0.0.9";
  await previous.put("artifacts/release.json", previous.release);
  await assert.rejects(verifyRelease(previous.outputFile, candidate.root), /content mismatch/);
  const original = await readFile(previous.outputFile);
  const candidateOriginal = await readFile(candidate.outputFile);
  assert.notDeepEqual(original, candidateOriginal);
  assert.equal(candidate.release.candidate.path, previous.release.candidate.path);
  const signatureFile = await previous.put("artifacts/release.json.sigstore.json", {
    signed: "original predecessor bytes",
  });
  const signature = await readFile(signatureFile);
  let checkedPrevious = false;
  const verifyPrevious = async (root, file, repository) => {
    assert.equal(root, previous.root);
    assert.equal(file, previous.outputFile);
    assert.equal(repository, "example/pstack");
    checkedPrevious = true;
    return { release: await verifyRelease(file, root) };
  };
  const run = async (args) => {
    const inspect = args.indexOf("inspect");
    if (inspect !== -1) {
      const reference = args.at(-1);
      const images = [
        ...Object.values(previous.release.images),
        ...Object.values(candidate.candidate.images),
      ];
      const image = images.find((entry) => entry.id === reference || entry.reference === reference);
      assert.ok(image, "Only verified images may be inspected");
      return JSON.stringify([{ Id: image.id, Os: "linux", Architecture: "arm64" }]);
    }
    const input = args.indexOf("--input");
    if (input !== -1) assert.ok(args[input + 1].startsWith(`${candidate.root}${path.sep}`));
    return "";
  };
  const drill = async (before, after, context, report) => {
    assert.equal(before.version, "0.0.9");
    assert.deepEqual(rollbackIdentity(after), rollbackIdentity(candidate.candidate));
    assert.equal(context, "disposable-fixture");
    const integrity = await readFile(path.join(candidate.root, migrationLedgerPath), "utf8");
    const history = { ledgerSha256: sha256(integrity), integrity };
    report.migration = {
      availability: {
        before: [0, 1].map((i) => ({
          id: String(i).repeat(64),
          startedAt: "started",
          restarts: 0,
        })),
        after: [0, 1].map((i) => ({ id: String(i).repeat(64), startedAt: "started", restarts: 0 })),
        successfulWrites: 1,
        failedWrites: 0,
        maxLatencyMs: 1,
        requestTimeoutMs: 2000,
      },
      previous: history,
      candidate: history,
      before: expectedApplied(history),
      after: expectedApplied(history),
      imageId: candidate.candidate.images.web.id,
      command: "pnpm --filter @pstack/database db:migrate",
      exitCode: 0,
    };
    report.checks.push(...rollbackChecks, ...migrationChecks);
    report.status = "passed";
  };
  const proofFile = await createRollbackProof(
    {
      root: candidate.root,
      previousRoot: previous.root,
      candidateFile: candidate.candidateFile,
      evidenceFile: candidate.evidenceFile,
      previousFile: previous.outputFile,
      repository: "example/pstack",
      output: path.join(candidate.root, "artifacts/rollback"),
      context: "disposable-fixture",
    },
    { verifyPrevious, run, drill },
  );
  assert.equal(checkedPrevious, true);
  assert.ok(proofFile.startsWith(`${candidate.root}${path.sep}`));
  await verifyRollbackProof({
    root: candidate.root,
    proofFile,
    candidate: candidate.candidate,
    previous: previous.release,
  });
  assert.deepEqual(await readFile(previous.outputFile), original);
  assert.deepEqual(await readFile(signatureFile), signature);
  assert.deepEqual(await readFile(candidate.outputFile), candidateOriginal);
});
