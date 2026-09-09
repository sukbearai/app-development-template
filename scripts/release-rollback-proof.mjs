#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dockerCommand } from "./deployment-compose.mjs";
import { verifiedDeploymentBundle } from "./deployment-executor.mjs";
import { inside, migrationLedgerPath, verifyCandidateInputs } from "./release-manifest.mjs";
import { rollbackIdentity, rollbackProofSchema, verifyRollbackProof } from "./rollback-proof.mjs";
import { runRollbackDrill } from "./rollback-drill-runtime.mjs";
import { evidenceReference, sha256 } from "./verification-evidence.mjs";

export async function createRollbackProof(
  {
    root,
    previousRoot = root,
    candidateFile,
    evidenceFile,
    previousFile,
    repository,
    output,
    context,
  },
  { verifyPrevious = verifiedDeploymentBundle, run = dockerCommand, drill = runRollbackDrill } = {},
) {
  const { candidate } = await verifyCandidateInputs({ root, candidateFile, evidenceFile });
  const { release: previous } = await verifyPrevious(previousRoot, previousFile, repository);
  const ledger = sha256(await readFile(path.join(root, migrationLedgerPath)));
  assert.equal(previous.compatibility.recoveryProtocol, "pstack-recovery-v2");
  const docker = (args) => run(["--context", context, ...args], process.env);
  const candidateRuntime = structuredClone(candidate);
  for (const role of ["web", "worker"]) {
    assert.equal(
      candidate.images[role].platform,
      previous.images[role].platform,
      "Rollback platform mismatch",
    );
    await docker([
      "pull",
      "--platform",
      previous.images[role].platform,
      previous.images[role].reference,
    ]);
    const [priorImage] = JSON.parse(
      await docker(["image", "inspect", previous.images[role].reference]),
    );
    assert.equal(priorImage.Id, previous.images[role].id, "Predecessor image ID mismatch");
    await docker(["load", "--input", inside(root, candidate.images[role].archive.path)]);
    const [image] = JSON.parse(await docker(["image", "inspect", candidate.images[role].id]));
    assert.equal(`${image.Os}/${image.Architecture}`, candidate.images[role].platform);
    candidateRuntime.images[role].reference = image.Id;
  }
  await mkdir(output, { recursive: true });
  const pair = {
    previous: { version: previous.version, ...rollbackIdentity(previous) },
    candidate: rollbackIdentity(candidate),
  };
  const report = { schemaVersion: 2, ...pair, status: "failed", checks: [], cleanupErrors: [] };
  const reportFile = path.join(output, "rollback-drill.json");
  try {
    await drill(previous, candidateRuntime, context, report);
  } finally {
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  assert.equal(report.status, "passed", "Rollback drill failed");
  assert.equal(report.migration.candidate.ledgerSha256, ledger, "Candidate image ledger mismatch");
  assert.equal(
    report.migration.previous.ledgerSha256,
    previous.compatibility.migrationLedgerSha256,
    "Predecessor image ledger mismatch",
  );
  const proof = rollbackProofSchema.parse({
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    ...pair,
    migration: report.migration,
    recoveryProtocol: "pstack-recovery-v2",
    checks: report.checks,
    evidence: await evidenceReference(root, reportFile),
  });
  const proofFile = path.join(output, "rollback-proof.json");
  await writeFile(proofFile, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  await verifyRollbackProof({ root, proofFile, candidate, previous });
  return proofFile;
}
async function main() {
  const options = parseArgs({
    strict: true,
    options: {
      root: { type: "string", default: process.cwd() },
      candidate: { type: "string" },
      evidence: { type: "string" },
      previous: { type: "string" },
      "previous-root": { type: "string" },
      repo: { type: "string" },
      output: { type: "string" },
      context: { type: "string" },
    },
  }).values;
  for (const key of ["candidate", "evidence", "previous", "repo", "output", "context"])
    assert.ok(options[key], `--${key} is required`);
  const root = path.resolve(options.root);
  const previousRoot = path.resolve(options["previous-root"] ?? root);
  const file = await createRollbackProof({
    root,
    candidateFile: inside(root, options.candidate),
    evidenceFile: inside(root, options.evidence),
    previousRoot,
    previousFile: inside(previousRoot, options.previous),
    repository: options.repo,
    output: inside(root, options.output),
    context: options.context,
  });
  process.stdout.write(`${file}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("ROLLBACK_PROOF_FAILED\n");
    process.exitCode = 1;
  }
}
