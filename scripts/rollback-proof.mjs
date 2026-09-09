import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { evidenceReference, sourceSchema, sha256 } from "./verification-evidence.mjs";

import {
  migrationExecutionSchema,
  verifyMigrationExecution,
  verifyMigrationPrefix,
} from "./migration-compatibility.mjs";

const verifiedProofs = new WeakMap();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.strictObject({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.string(),
});
const images = z.strictObject({ web: image, worker: image });
const identity = z.strictObject({ source: sourceSchema, images });
export const rollbackChecks = [
  "previous application writes persisted data",
  "candidate application reads previous data and writes persisted data",
  "previous application reads candidate data after rollback",
  "worker recovery and duplicate delivery remain idempotent",
];
const proofBase = z.strictObject({
  createdAt: z.iso.datetime(),
  previous: identity.extend({ version: z.string() }),
  candidate: identity,
  recoveryProtocol: z.literal("pstack-recovery-v2"),
  checks: z.array(z.string()),
  evidence: z.strictObject({
    path: z.string(),
    sha256: hash,
    bytes: z.number().int().nonnegative(),
  }),
});
export const migrationChecks = [
  "candidate migration applies immutable history while previous application runs",
  "previous application reads and writes migrated schema",
  "mixed applications read each other data with both workers running",
  "previous application writes continuously without restart during migration",
  "candidate worker processes data without the predecessor worker",
];
export const rollbackProofSchema = z.discriminatedUnion("schemaVersion", [
  proofBase.extend({ schemaVersion: z.literal(1), migrationLedgerSha256: hash }),
  proofBase.extend({ schemaVersion: z.literal(2), migration: migrationExecutionSchema }),
]);
function ledgers(proof) {
  return proof.schemaVersion === 1
    ? { previous: proof.migrationLedgerSha256, candidate: proof.migrationLedgerSha256 }
    : {
        previous: proof.migration.previous.ledgerSha256,
        candidate: proof.migration.candidate.ledgerSha256,
      };
}
export function rollbackIdentity(release) {
  return {
    source: release.source,
    images: Object.fromEntries(
      ["web", "worker"].map((role) => [
        role,
        { id: release.images[role].id, platform: release.images[role].platform },
      ]),
    ),
  };
}
async function referenceFile(root, ref) {
  assert.ok(
    !path.isAbsolute(ref.path) && !ref.path.split(/[\\/]/).includes(".."),
    "Unsafe rollback evidence path",
  );
  const file = path.join(root, ref.path);
  assert.deepEqual(await evidenceReference(root, file), ref, "Rollback evidence content mismatch");
  return file;
}
async function readProof(root, proofFile) {
  const proof = rollbackProofSchema.parse(JSON.parse(await readFile(proofFile, "utf8")));
  for (const check of rollbackChecks)
    assert.ok(proof.checks.includes(check), `Missing rollback check: ${check}`);
  const evidence = JSON.parse(await readFile(await referenceFile(root, proof.evidence), "utf8"));
  assert.equal(evidence.status, "passed", "Rollback drill failed");
  assert.equal(evidence.schemaVersion, proof.schemaVersion);
  if (proof.schemaVersion === 2) {
    for (const check of migrationChecks)
      assert.ok(proof.checks.includes(check), `Missing migration check: ${check}`);
    verifyMigrationExecution(proof.migration);
    assert.equal(
      proof.migration.imageId,
      proof.candidate.images.web.id,
      "Migration image mismatch",
    );
    assert.deepEqual(evidence.migration, proof.migration, "Migration execution evidence mismatch");
  }
  assert.deepEqual(evidence.previous, proof.previous, "Rollback predecessor evidence mismatch");
  assert.deepEqual(evidence.candidate, proof.candidate, "Rollback candidate evidence mismatch");
  assert.deepEqual(evidence.checks, proof.checks, "Rollback behavior evidence mismatch");
  assert.deepEqual(evidence.cleanupErrors, [], "Rollback drill cleanup failed");
  return proof;
}
export async function verifyRollbackProof({
  root,
  proofFile,
  candidate,
  previous,
  candidateLedgerSha256,
}) {
  const proof = await readProof(root, proofFile);
  assert.deepEqual(proof.candidate, rollbackIdentity(candidate), "Rollback candidate mismatch");
  assert.deepEqual(
    proof.previous,
    { version: previous.version, ...rollbackIdentity(previous) },
    "Rollback predecessor mismatch",
  );
  assert.equal(
    ledgers(proof).previous,
    previous.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
  assert.equal(
    proof.recoveryProtocol,
    previous.compatibility.recoveryProtocol,
    "Rollback recovery protocol mismatch",
  );
  const candidateLedger =
    candidateLedgerSha256 ??
    candidate.compatibility?.migrationLedgerSha256 ??
    sha256(await readFile(path.join(root, "packages/database/migrations/template/integrity.json")));
  assert.equal(ledgers(proof).candidate, candidateLedger, "Rollback candidate ledger mismatch");
  return proof;
}
export async function verifyCandidateRollback(root, release, candidate) {
  const reference = release.compatibility.rollbackProof;
  if (!reference) {
    assert.deepEqual(
      release.compatibility.rollbackVersions,
      [],
      "Rollback versions require pairwise proof",
    );
    return null;
  }
  const proof = await readProof(root, await referenceFile(root, reference));
  assert.deepEqual(proof.candidate, rollbackIdentity(candidate), "Rollback candidate mismatch");
  assert.equal(
    ledgers(proof).candidate,
    release.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
  assert.equal(
    proof.recoveryProtocol,
    release.compatibility.recoveryProtocol,
    "Rollback recovery protocol mismatch",
  );
  assert.deepEqual(
    release.compatibility.rollbackVersions,
    [proof.previous.version],
    "Rollback versions must derive from pairwise proof",
  );
  return proof;
}
export async function verifyReleaseRollback(root, release, previous) {
  const proof = await verifyCandidateRollback(root, release, release);
  assert.ok(proof, "PAIRWISE_ROLLBACK_PROOF_REQUIRED");
  assert.deepEqual(
    proof.previous,
    { version: previous.version, ...rollbackIdentity(previous) },
    "Rollback predecessor mismatch",
  );
  assert.equal(
    ledgers(proof).previous,
    previous.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
  assert.equal(
    previous.compatibility.recoveryProtocol,
    release.compatibility.recoveryProtocol,
    "Rollback recovery protocol mismatch",
  );
  verifiedProofs.set(proof, sha256(JSON.stringify(proof)));
  return proof;
}

export function assertVerifiedTransitionProof(proof, current, target, rollback) {
  assert.equal(
    verifiedProofs.get(proof),
    sha256(JSON.stringify(proof)),
    "VERIFIED_MIGRATION_PROOF_REQUIRED",
  );
  const release = rollback ? current : target;
  const previous = rollback ? target : current;
  assert.deepEqual(proof.candidate, rollbackIdentity(release), "Rollback candidate mismatch");
  assert.deepEqual(
    proof.previous,
    { version: previous.version, ...rollbackIdentity(previous) },
    "Rollback predecessor mismatch",
  );
  assert.equal(
    ledgers(proof).candidate,
    release.compatibility.migrationLedgerSha256,
    "Rollback candidate ledger mismatch",
  );
  assert.equal(
    ledgers(proof).previous,
    previous.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
}

// The schema head remains newer when applications roll back. It is independently retained.
export async function verifyDeploymentTransition({
  root,
  release,
  previous,
  schemaRelease = previous,
  schemaRoot = root,
  previousRoot = schemaRoot,
  rollback = false,
}) {
  assert.ok(previous && schemaRelease, "SCHEMA_ANCHOR_REQUIRED");
  assert.equal(
    previous.compatibility.recoveryProtocol,
    release.compatibility.recoveryProtocol,
    "Unsupported recovered-worker protocol",
  );
  if (rollback) {
    const proof = await verifyReleaseRollback(previousRoot, previous, release);
    if (
      schemaRelease.compatibility.migrationLedgerSha256 !==
      previous.compatibility.migrationLedgerSha256
    )
      await verifyReleaseRollback(schemaRoot, schemaRelease, release);
    return proof;
  }
  const proof = await verifyReleaseRollback(root, release, previous);
  if (
    schemaRelease.compatibility.migrationLedgerSha256 ===
    previous.compatibility.migrationLedgerSha256
  )
    return proof;
  if (
    schemaRelease.compatibility.migrationLedgerSha256 ===
    release.compatibility.migrationLedgerSha256
  )
    return proof;
  assert.equal(proof.schemaVersion, 2, "MIGRATED_SCHEMA_REQUIRES_V2_PROOF");
  const anchorProof = await verifyCandidateRollback(schemaRoot, schemaRelease, schemaRelease);
  assert.ok(anchorProof?.schemaVersion === 2, "SCHEMA_ANCHOR_HISTORY_REQUIRED");
  verifyMigrationPrefix(anchorProof.migration.candidate, proof.migration.candidate);
  return proof;
}
