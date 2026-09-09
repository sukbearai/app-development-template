import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rollbackChecks,
  migrationChecks,
  verifyReleaseRollback,
  verifyDeploymentTransition,
  rollbackIdentity,
  verifyCandidateRollback,
  verifyRollbackProof,
} from "../rollback-proof.mjs";
import { expectedApplied } from "../migration-compatibility.mjs";
import { sha256 } from "../verification-evidence.mjs";
import { verifyTransition } from "../release-plan.mjs";
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

function history(entries) {
  const integrity = JSON.stringify({
    ...Object.fromEntries(
      entries.map((entry, index) => [`${entry}.sql`, String(index + 1).repeat(64)]),
    ),
    $journal: entries.map((tag, idx) => ({
      idx,
      tag,
      version: "7",
      when: 1700000000000 + idx,
      breakpoints: true,
    })),
  });
  return { ledgerSha256: sha256(integrity), integrity };
}
async function migrationProofFixture(t) {
  const f = await releaseFixture(t);
  const previous = structuredClone(f.release);
  previous.version = "0.0.9";
  const before = history(["0000_initial"]);
  const after = history(["0000_initial", "0001_addition"]);
  previous.compatibility.migrationLedgerSha256 = before.ledgerSha256;
  f.release.compatibility.migrationLedgerSha256 = after.ledgerSha256;
  const migration = {
    availability: {
      before: [0, 1].map((i) => ({ id: String(i).repeat(64), startedAt: "started", restarts: 0 })),
      after: [0, 1].map((i) => ({ id: String(i).repeat(64), startedAt: "started", restarts: 0 })),
      successfulWrites: 1,
      failedWrites: 0,
      maxLatencyMs: 1,
      requestTimeoutMs: 2000,
    },
    previous: before,
    candidate: after,
    before: expectedApplied(before),
    after: expectedApplied(after),
    imageId: f.release.images.web.id,
    command: "pnpm --filter @pstack/database db:migrate",
    exitCode: 0,
  };
  const pair = {
    previous: { version: previous.version, ...rollbackIdentity(previous) },
    candidate: rollbackIdentity(f.release),
  };
  const checks = [...rollbackChecks, ...migrationChecks];
  const report = {
    schemaVersion: 2,
    status: "passed",
    ...pair,
    migration,
    checks,
    cleanupErrors: [],
  };
  const proof = {
    schemaVersion: 2,
    createdAt: f.release.createdAt,
    ...pair,
    migration,
    recoveryProtocol: "pstack-recovery-v2",
    checks,
  };
  async function save() {
    await f.put("artifacts/drill.json", report);
    await f.put("artifacts/rollback.json", {
      ...proof,
      evidence: await f.ref("artifacts/drill.json"),
    });
    f.release.compatibility.rollbackProof = await f.ref("artifacts/rollback.json");
    f.release.compatibility.rollbackVersions = [previous.version];
  }
  await save();
  return { f, previous, migration, report, proof, save };
}
test("changed schema requires verified pairwise execution, including unchanged SQL history", async (t) => {
  const { f, previous, migration, save } = await migrationProofFixture(t);
  assert.throws(
    () => verifyTransition(previous, f.release, false, { schemaVersion: 2 }),
    /VERIFIED_MIGRATION/,
  );
  const verified = await verifyReleaseRollback(f.root, f.release, previous);
  verifyTransition(previous, f.release, false, verified);
  await verifyDeploymentTransition({
    root: f.root,
    release: previous,
    previous: f.release,
    schemaRoot: f.root,
    schemaRelease: f.release,
    rollback: true,
  });
  migration.after = migration.before;
  await save();
  await assert.rejects(
    verifyReleaseRollback(f.root, f.release, previous),
    /MIGRATION_AFTER_MISMATCH/,
  );
  migration.after = expectedApplied(migration.candidate);
  const changed = JSON.parse(migration.candidate.integrity);
  changed["0000_initial.sql"] = "f".repeat(64);
  migration.candidate.integrity = JSON.stringify(changed);
  migration.candidate.ledgerSha256 = sha256(migration.candidate.integrity);
  f.release.compatibility.migrationLedgerSha256 = migration.candidate.ledgerSha256;
  await save();
  await assert.rejects(
    verifyReleaseRollback(f.root, f.release, previous),
    /MIGRATION_HISTORY_PREFIX_MISMATCH/,
  );
});
test("v1 proof cannot authorize a different candidate ledger", async (t) => {
  const { f, previous, proof, report } = await migrationProofFixture(t);
  const oldProof = {
    ...proof,
    schemaVersion: 1,
    migrationLedgerSha256: previous.compatibility.migrationLedgerSha256,
  };
  delete oldProof.migration;
  const oldReport = { ...report, schemaVersion: 1 };
  delete oldReport.migration;
  await f.put("artifacts/drill.json", oldReport);
  await f.put("artifacts/rollback.json", {
    ...oldProof,
    evidence: await f.ref("artifacts/drill.json"),
  });
  f.release.compatibility.rollbackProof = await f.ref("artifacts/rollback.json");
  await assert.rejects(verifyReleaseRollback(f.root, f.release, previous), /ledger mismatch/);
});
test("upgrade after application rollback preserves the independently retained schema history", async (t) => {
  const { f, previous, migration, report, proof, save } = await migrationProofFixture(t);
  const schemaRelease = structuredClone(f.release);
  await f.put("artifacts/schema-drill.json", report);
  await f.put("artifacts/schema-proof.json", {
    ...proof,
    evidence: await f.ref("artifacts/schema-drill.json"),
  });
  schemaRelease.compatibility.rollbackProof = await f.ref("artifacts/schema-proof.json");
  f.release.version = "0.2.0";
  f.release.source.gitSha = "e".repeat(40);
  report.candidate = rollbackIdentity(f.release);
  proof.candidate = report.candidate;
  migration.candidate = history(["0000_initial", "0001_addition", "0002_next"]);
  migration.after = expectedApplied(migration.candidate);
  f.release.compatibility.migrationLedgerSha256 = migration.candidate.ledgerSha256;
  await save();
  await verifyDeploymentTransition({
    root: f.root,
    release: f.release,
    previous,
    schemaRelease,
    schemaRoot: f.root,
  });
  migration.candidate = history(["0000_initial", "0001_divergent"]);
  migration.after = expectedApplied(migration.candidate);
  f.release.compatibility.migrationLedgerSha256 = migration.candidate.ledgerSha256;
  await save();
  await assert.rejects(
    verifyDeploymentTransition({
      root: f.root,
      release: f.release,
      previous,
      schemaRelease,
      schemaRoot: f.root,
    }),
    /MIGRATION_HISTORY_PREFIX_MISMATCH/,
  );
});
test("migration proof rejects predecessor restarts, request failures, and missing candidate worker evidence", async (t) => {
  const { f, previous, migration, proof, report, save } = await migrationProofFixture(t);
  migration.availability.after[0].restarts++;
  await save();
  await assert.rejects(
    verifyReleaseRollback(f.root, f.release, previous),
    /PREVIOUS_APPLICATION_RESTARTED/,
  );
  migration.availability.after[0].restarts--;
  migration.availability.failedWrites = 1;
  await save();
  await assert.rejects(verifyReleaseRollback(f.root, f.release, previous));
  migration.availability.failedWrites = 0;
  proof.checks = proof.checks.filter((check) => check !== migrationChecks[4]);
  report.checks = proof.checks;
  await save();
  await assert.rejects(
    verifyReleaseRollback(f.root, f.release, previous),
    /Missing migration check/,
  );
});
