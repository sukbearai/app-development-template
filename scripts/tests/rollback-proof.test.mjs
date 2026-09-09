import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rollbackChecks,
  rollbackIdentity,
  verifyCandidateRollback,
  verifyRollbackProof,
} from "../rollback-proof.mjs";
import { releaseFixture } from "./release-fixture.mjs";

test("rollback proof binds actual candidate and predecessor and rejects changed evidence", async (t) => {
  const f = await releaseFixture(t);
  const previous = structuredClone(f.release);
  previous.version = "0.0.9";
  const pair = {
    previous: { version: previous.version, ...rollbackIdentity(previous) },
    candidate: rollbackIdentity(f.candidate),
  };
  const report = {
    schemaVersion: 1,
    status: "passed",
    ...pair,
    checks: rollbackChecks,
    cleanupErrors: [],
  };
  await f.put("artifacts/drill.json", report);
  const proof = {
    schemaVersion: 1,
    createdAt: f.release.createdAt,
    ...pair,
    migrationLedgerSha256: previous.compatibility.migrationLedgerSha256,
    recoveryProtocol: previous.compatibility.recoveryProtocol,
    checks: rollbackChecks,
    evidence: await f.ref("artifacts/drill.json"),
  };
  await f.put("artifacts/rollback.json", proof);
  const proofFile = `${f.root}/artifacts/rollback.json`;
  await verifyRollbackProof({ root: f.root, proofFile, candidate: f.candidate, previous });
  f.release.compatibility.rollbackProof = await f.ref("artifacts/rollback.json");
  f.release.compatibility.rollbackVersions = [previous.version];
  await verifyCandidateRollback(f.root, f.release, f.candidate);
  const altered = structuredClone(f.candidate);
  altered.images.web.id = `sha256:${"e".repeat(64)}`;
  await assert.rejects(
    verifyRollbackProof({ root: f.root, proofFile, candidate: altered, previous }),
    /candidate mismatch/,
  );
  f.release.compatibility.rollbackVersions.push("0.0.8");
  await assert.rejects(verifyCandidateRollback(f.root, f.release, f.candidate), /derive/);
  await f.put("artifacts/drill.json", { ...report, checks: [] });
  await assert.rejects(
    verifyRollbackProof({ root: f.root, proofFile, candidate: f.candidate, previous }),
    /content mismatch/,
  );
});
test("rollback authorization rejects missing behavior proof", async (t) => {
  const f = await releaseFixture(t);
  f.release.compatibility.rollbackVersions = ["0.0.9"];
  await assert.rejects(verifyCandidateRollback(f.root, f.release, f.candidate), /pairwise proof/);
});
