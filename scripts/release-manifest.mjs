#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Version } from "release-please/build/src/version.js";
import { z } from "zod";
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { RELEASE_GATES } from "./verification-plan.mjs";
import { verifyScanEvidence } from "./release-security.mjs";
import { verifyCandidateRollback, verifyRollbackProof } from "./rollback-proof.mjs";
import {
  evidenceReference,
  sha256,
  sourceIdentity,
  sourceSchema,
  verifyEvidence,
} from "./verification-evidence.mjs";

const releaseChecksV1 = Object.freeze([
  "format:check",
  "sdk:check",
  "lint",
  "duplication:check",
  "boundary:check",
  "dependency:check",
  "supply-chain:check",
  "security:audit",
  "typecheck",
  "contract:check",
  "migration:check",
  "version:check",
  "docs:check",
  "test:tools",
  "test:unit",
  "test:integration",
  "build",
  "storybook:test",
  "storybook:smoke",
  "test:tracing-collector",
  "test:monitor-collector",
  "test:deployment",
  "test:deployment:slots",
  "db:integration",
  "test:e2e",
  "test:ui",
  "test:ui:production",
  "test:async-recovery",
  "test:kafka-security",
  "test:capacity",
  "test:backup",
  "test:app-backup",
  "test:containers",
]);
const releaseChecksV2 = Object.freeze([...releaseChecksV1, "conventions:check"]);
assert.deepEqual(
  [...RELEASE_GATES].sort(),
  [...releaseChecksV2].sort(),
  "Release gates changed; add a new manifest schema policy without changing published policies",
);

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/);
const reference = z.strictObject({
  path: z.string().min(1),
  sha256: hash,
  bytes: z.number().int().nonnegative(),
});
const platform = z.string().regex(/^linux\/(amd64|arm64)(?:\/v[1-9]\d*)?$/);
const candidateImage = z.strictObject({ id: digest, archive: reference, platform });
export const candidateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sourceSchema,
  createdAt: z.iso.datetime(),
  images: z.strictObject({ web: candidateImage, worker: candidateImage }),
  verification: reference,
});
const publishedImage = z.strictObject({
  reference: z.string().regex(/^[a-z0-9][a-z0-9.:/-]*@sha256:[a-f0-9]{64}$/),
  id: digest,
  platform,
  manifest: reference,
});
export const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sourceSchema,
  images: z.strictObject({ web: publishedImage, worker: publishedImage }),
});
export const releaseSchema = z
  .strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    version,
    tag: z.string(),
    source: sourceSchema,
    createdAt: z.iso.datetime(),
    toolchain: z.strictObject({
      node: z.string(),
      packageManager: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    ciRun: z.string().nullable(),
    images: receiptSchema.shape.images,
    evidence: reference,
    candidate: reference,
    receipt: reference,
    security: reference,
    compatibility: z.strictObject({
      migrationLedgerSha256: hash,
      recoveryProtocol: z.literal("pstack-recovery-v2"),
      rollbackVersions: z.array(version),
      rollbackProof: reference.nullable(),
    }),
  })
  .refine((value) => value.tag === `v${value.version}`, "Release tag/version mismatch")
  .refine(
    (value) =>
      value.schemaVersion !== 1 ||
      Version.parse(value.version).compare(Version.parse("0.2.3")) <= 0,
    "Manifest schema v1 is limited to releases through 0.2.3",
  );
export const mandatoryReleaseChecks = RELEASE_GATES;
export const requiredContainerChecks = [
  "built Web image runs migration and administrator bootstrap",
  "production Docker Web passes HTTP authentication, RBAC, upload, telemetry and health smoke",
  "built worker publishes via real Kafka, consumes Web events and persists one receipt after duplicate publication",
  "Docker SIGTERM drains worker and records stopped heartbeat with exit 0",
  "Docker SIGTERM drains the built Web process with exit 0",
];
export const migrationLedgerPath = "packages/database/migrations/template/integrity.json";
export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
export function inside(root, name) {
  assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."), "Unsafe release path");
  return path.join(root, name);
}
export async function verifyReference(root, ref) {
  assert.deepEqual(
    await evidenceReference(root, inside(root, ref.path)),
    ref,
    "Release file content mismatch",
  );
  return inside(root, ref.path);
}
export async function verifyCandidateInputs({
  root,
  candidateFile,
  evidenceFile,
  requireCheckout = true,
}) {
  return validateCandidateInputs(
    { root, candidateFile, evidenceFile, requireCheckout },
    mandatoryReleaseChecks,
  );
}
async function validateCandidateInputs(
  { root, candidateFile, evidenceFile, requireCheckout },
  requiredChecks,
) {
  const candidate = candidateSchema.parse(await readJson(candidateFile));
  assert.equal(candidate.source.dirty, false, "Release requires clean source");
  if (requireCheckout)
    assert.deepEqual(
      await sourceIdentity(root),
      candidate.source,
      "Release checkout source mismatch",
    );
  const evidence = await verifyEvidence(evidenceFile, root, candidate.source);
  for (const gate of requiredChecks)
    assert.ok(
      evidence.checks.some((check) => check.name === gate && check.status === "passed"),
      `Missing mandatory release check: ${gate}`,
    );
  const summary = await readJson(await verifyReference(root, candidate.verification));
  assert.deepEqual(summary.source, candidate.source, "Container verification source mismatch");
  assert.equal(summary.status, "passed", "Container verification failed");
  for (const check of requiredContainerChecks)
    assert.ok(summary.checks?.includes(check), `Missing container behavior check: ${check}`);
  assert.ok(!summary.cleanupErrors?.length, "Container cleanup failed");
  const containerCheck = evidence.checks.find((check) => check.name === "test:containers");
  assert.ok(
    containerCheck.evidence.some(
      (ref) =>
        ref.path === candidate.verification.path &&
        ref.sha256 === candidate.verification.sha256 &&
        ref.bytes === candidate.verification.bytes,
    ),
    "Container summary missing from evidence index",
  );
  for (const role of ["web", "worker"]) {
    const image = candidate.images[role];
    assert.equal(summary.images?.[role]?.id, image.id, "Container image identity mismatch");
    assert.equal(
      summary.images?.[role]?.platform,
      image.platform,
      "Container image platform mismatch",
    );
    await verifyReference(root, image.archive);
  }
  return { candidate, index: evidence };
}
async function validateInputs(
  root,
  candidateFile,
  evidenceFile,
  receiptFile,
  requiredChecks = mandatoryReleaseChecks,
) {
  const { candidate, index: evidence } = await validateCandidateInputs(
    { root, candidateFile, evidenceFile, requireCheckout: false },
    requiredChecks,
  );
  const receipt = receiptSchema.parse(await readJson(receiptFile));
  assert.deepEqual(receipt.source, candidate.source, "Registry receipt source mismatch");
  for (const role of ["web", "worker"]) {
    const image = candidate.images[role];
    const published = receipt.images[role];
    assert.equal(published.id, image.id, "Published image identity mismatch");
    assert.equal(published.platform, image.platform, "Published image platform mismatch");
    const manifestFile = await verifyReference(root, published.manifest);
    const manifestBytes = await readFile(manifestFile);
    assert.equal(
      published.reference.split("@")[1],
      `sha256:${sha256(manifestBytes)}`,
      "Registry manifest digest mismatch",
    );
    const manifest = z
      .object({
        schemaVersion: z.literal(2),
        mediaType: z.enum([
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ]),
        config: z.object({ digest }),
        layers: z.array(z.object({ digest })),
      })
      .parse(JSON.parse(manifestBytes));
    assert.equal(
      manifest.config.digest,
      image.id,
      "Registry manifest config differs from tested image",
    );
  }
  return { candidate, evidence, receipt };
}
export async function createRelease({
  root,
  candidateFile,
  evidenceFile,
  receiptFile,
  securityFile,
  rollbackProofFile,
  previousFile,
  previousRoot = root,
}) {
  const inputs = await validateInputs(root, candidateFile, evidenceFile, receiptFile);
  assert.deepEqual(
    await sourceIdentity(root),
    inputs.candidate.source,
    "Release checkout source mismatch",
  );
  const pkg = z
    .object({ version, packageManager: z.string() })
    .parse(await readJson(path.join(root, "package.json")));
  const environment = inputs.evidence.environment;
  assert.ok(securityFile, "Security evidence is required");
  const security = await evidenceReference(root, securityFile);
  await verifyScanEvidence(root, inputs.candidate, security);
  assert.equal(
    Boolean(rollbackProofFile),
    Boolean(previousFile),
    "Rollback proof requires a previous release",
  );
  let rollbackVersions = [];
  let rollbackProof = null;
  if (rollbackProofFile) {
    const previous = await verifyRelease(previousFile, previousRoot);
    await verifyRollbackProof({
      root,
      proofFile: rollbackProofFile,
      candidate: inputs.candidate,
      previous,
    });
    rollbackVersions = [previous.version];
    rollbackProof = await evidenceReference(root, rollbackProofFile);
  }
  const release = releaseSchema.parse({
    schemaVersion: 2,
    version: pkg.version,
    tag: `v${pkg.version}`,
    source: inputs.candidate.source,
    createdAt: inputs.candidate.createdAt,
    toolchain: {
      node: environment.node,
      packageManager: pkg.packageManager,
      platform: environment.platform,
      arch: environment.arch,
    },
    ciRun: environment.ciRun,
    images: inputs.receipt.images,
    evidence: await evidenceReference(root, evidenceFile),
    candidate: await evidenceReference(root, candidateFile),
    receipt: await evidenceReference(root, receiptFile),
    security,
    compatibility: {
      migrationLedgerSha256: sha256(await readFile(path.join(root, migrationLedgerPath))),
      recoveryProtocol: "pstack-recovery-v2",
      rollbackVersions,
      rollbackProof,
    },
  });
  await verifyCandidateRollback(root, release, inputs.candidate);
  return release;
}
export async function createReleaseManifest({
  root,
  candidateFile,
  evidenceFile,
  receiptFile,
  outputFile,
  securityFile,
  rollbackProofFile,
  previousFile,
  previousRoot = root,
}) {
  const release = await createRelease({
    root,
    candidateFile,
    evidenceFile,
    receiptFile,
    securityFile,
    rollbackProofFile,
    previousFile,
    previousRoot,
  });
  const content = `${JSON.stringify(release, null, 2)}\n`;
  try {
    await writeFile(outputFile, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    assert.equal(
      await readFile(outputFile, "utf8"),
      content,
      "Refusing to overwrite a different release manifest",
    );
  }
  return release;
}
export async function verifyRelease(file, root) {
  const release = releaseSchema.parse(await readJson(file));
  const inputs = await validateInputs(
    root,
    await verifyReference(root, release.candidate),
    await verifyReference(root, release.evidence),
    await verifyReference(root, release.receipt),
    release.schemaVersion === 1 ? releaseChecksV1 : releaseChecksV2,
  );
  assert.deepEqual(release.source, inputs.candidate.source, "Release source mismatch");
  assert.deepEqual(
    release.images,
    inputs.receipt.images,
    "Release images differ from registry receipt",
  );
  assert.equal(release.ciRun, inputs.evidence.environment.ciRun, "Release CI run mismatch");
  await verifyScanEvidence(root, inputs.candidate, release.security);
  await verifyCandidateRollback(root, release, inputs.candidate);
  return release;
}
async function main() {
  const json = process.argv.includes("--json");
  let options;
  try {
    options = parseArgs({
      options: {
        root: { type: "string", default: process.cwd() },
        candidate: { type: "string" },
        evidence: { type: "string" },
        receipt: { type: "string" },
        output: { type: "string" },
        security: { type: "string" },
        "rollback-proof": { type: "string" },
        previous: { type: "string" },
        "previous-root": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
    }).values;
    for (const key of ["candidate", "evidence", "receipt", "output", "security"])
      assert.ok(options[key], `--${key} is required`);
    for (const key of ["candidate", "evidence", "receipt", "output", "security"])
      inside(options.root, options[key]);
    if (options["rollback-proof"]) inside(options.root, options["rollback-proof"]);
    if (options.previous) inside(options["previous-root"] ?? options.root, options.previous);
    assert.equal(
      Boolean(options["rollback-proof"]),
      Boolean(options.previous),
      "--rollback-proof and --previous must be supplied together",
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(
      commandResult({
        command: "release:manifest",
        status: "invalid",
        errorCode: "INVALID_ARGUMENT",
      }),
      json,
    );
    return;
  }
  try {
    const release = await createReleaseManifest({
      root: options.root,
      candidateFile: inside(options.root, options.candidate),
      evidenceFile: inside(options.root, options.evidence),
      receiptFile: inside(options.root, options.receipt),
      outputFile: inside(options.root, options.output),
      securityFile: inside(options.root, options.security),
      rollbackProofFile: options["rollback-proof"]
        ? inside(options.root, options["rollback-proof"])
        : undefined,
      previousFile: options.previous
        ? inside(options["previous-root"] ?? options.root, options.previous)
        : undefined,
      previousRoot: options["previous-root"] ?? options.root,
    });
    printCommandResult(
      commandResult({
        command: "release:manifest",
        status: "passed",
        evidence: options.output,
        data: release,
      }),
      json,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(
      commandResult({
        command: "release:manifest",
        status: "failed",
        errorCode: "RELEASE_INVALID",
      }),
      json,
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
