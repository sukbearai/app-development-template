import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { evidenceReference, sourceSchema } from "./verification-evidence.mjs";

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
export const rollbackProofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  previous: identity.extend({ version: z.string() }),
  candidate: identity,
  migrationLedgerSha256: hash,
  recoveryProtocol: z.literal("pstack-recovery-v2"),
  checks: z.array(z.string()),
  evidence: z.strictObject({
    path: z.string(),
    sha256: hash,
    bytes: z.number().int().nonnegative(),
  }),
});
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
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(evidence.previous, proof.previous, "Rollback predecessor evidence mismatch");
  assert.deepEqual(evidence.candidate, proof.candidate, "Rollback candidate evidence mismatch");
  assert.deepEqual(evidence.checks, proof.checks, "Rollback behavior evidence mismatch");
  assert.deepEqual(evidence.cleanupErrors, [], "Rollback drill cleanup failed");
  return proof;
}
export async function verifyRollbackProof({ root, proofFile, candidate, previous }) {
  const proof = await readProof(root, proofFile);
  assert.deepEqual(proof.candidate, rollbackIdentity(candidate), "Rollback candidate mismatch");
  assert.deepEqual(
    proof.previous,
    { version: previous.version, ...rollbackIdentity(previous) },
    "Rollback predecessor mismatch",
  );
  assert.equal(
    proof.migrationLedgerSha256,
    previous.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
  assert.equal(
    proof.recoveryProtocol,
    previous.compatibility.recoveryProtocol,
    "Rollback recovery protocol mismatch",
  );
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
    proof.migrationLedgerSha256,
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
    previous.compatibility.migrationLedgerSha256,
    release.compatibility.migrationLedgerSha256,
    "Rollback ledger mismatch",
  );
  assert.equal(
    previous.compatibility.recoveryProtocol,
    release.compatibility.recoveryProtocol,
    "Rollback recovery protocol mismatch",
  );
  return proof;
}
