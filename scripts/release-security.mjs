#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { evidenceReference, fileHash, sha256, sourceSchema } from "./verification-evidence.mjs";

import { toolchain } from "./toolchain.mjs";
export { toolchain };

const reference = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
const scanImage = z.strictObject({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  archive: reference,
  report: reference,
  sbom: reference,
});
export const securitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: sourceSchema,
  scannedAt: z.iso.datetime(),
  scanner: z.string().regex(/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.strictObject({
    severities: z.array(z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"])).min(1),
    maxScanAgeHours: z.number().positive(),
    maxDatabaseAgeHours: z.number().positive(),
    exceptions: z.tuple([]),
  }),
  database: reference,
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  audit: reference,
  images: z.strictObject({ web: scanImage, worker: scanImage }),
  outcome: z.literal("passed"),
});
export function securityPath(root, relative) {
  assert.ok(
    !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."),
    "Unsafe security evidence path",
  );
  return path.join(root, relative);
}
export async function securityReference(root, ref) {
  reference.parse(ref);
  const file = securityPath(root, ref.path);
  assert.deepEqual(await evidenceReference(root, file), ref, "Security evidence content mismatch");
  return file;
}
export function checkAudit(report, policy = toolchain.policy) {
  const counts = z
    .object({
      metadata: z.object({ vulnerabilities: z.record(z.string(), z.number().int().nonnegative()) }),
    })
    .parse(report).metadata.vulnerabilities;
  for (const level of policy.severities.map((severity) => severity.toLowerCase()))
    assert.equal(counts[level], 0, `Production dependency audit has ${level} findings`);
}
export function checkDatabase(database, now = Date.now(), policy = toolchain.policy) {
  const updated = Date.parse(database.UpdatedAt);
  const next = Date.parse(database.NextUpdate);
  assert.ok(
    Number.isFinite(updated) && Number.isFinite(next),
    "Malformed vulnerability database metadata",
  );
  assert.ok(
    updated <= now + 300000 && now - updated <= policy.maxDatabaseAgeHours * 3600000,
    "Stale vulnerability database",
  );
  assert.ok(next > updated, "Invalid database refresh interval");
}
export function checkReport(report, id, policy = toolchain.policy) {
  assert.equal(report.SchemaVersion, 2, "Unsupported vulnerability report");
  assert.equal(report.ArtifactType, "container_image", "Expected an image scan");
  assert.equal(report.Metadata?.ImageID, id, "Scanner image differs from tested archive");
  assert.ok(Array.isArray(report.Results) && report.Results.length > 0, "Empty vulnerability scan");
  for (const result of report.Results) {
    assert.ok(["os-pkgs", "lang-pkgs"].includes(result.Class), "Unexpected scanner result class");
    assert.ok(
      result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities),
      "Malformed vulnerabilities",
    );
    for (const finding of result.Vulnerabilities ?? []) {
      assert.ok(
        ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(finding.Severity),
        "Unknown severity",
      );
      assert.ok(
        !policy.severities.includes(finding.Severity),
        `Blocked vulnerability ${finding.VulnerabilityID} in ${finding.PkgName}`,
      );
    }
  }
}
export async function verifyScanEvidence(root, candidate, ref, options = {}) {
  const evidence = securitySchema.parse(
    JSON.parse(await readFile(await securityReference(root, ref), "utf8")),
  );
  assert.equal(
    evidence.policySha256,
    sha256(JSON.stringify(evidence.policy)),
    "Historical security policy hash mismatch",
  );
  assert.deepEqual(evidence.source, candidate.source, "Scan source differs from candidate");
  const age = (options.now ?? Date.now()) - Date.parse(evidence.scannedAt);
  assert.ok(age >= -300000, "Security scan is in the future");
  if (options.fresh) {
    assert.ok(age <= toolchain.policy.maxScanAgeHours * 3600000, "Expired security scan");
    assert.equal(evidence.scanner, toolchain.images.trivy, "Scanner policy changed");
    assert.equal(
      evidence.policySha256,
      sha256(JSON.stringify(toolchain.policy)),
      "Security policy changed",
    );
  }
  const json = async (item) =>
    JSON.parse(await readFile(await securityReference(root, item), "utf8"));
  const database = await json(evidence.database);
  checkDatabase(database, Date.parse(evidence.scannedAt), evidence.policy);
  checkAudit(await json(evidence.audit), evidence.policy);
  for (const role of ["web", "worker"]) {
    const image = evidence.images[role];
    assert.equal(image.id, candidate.images[role].id, "Scan image differs from candidate");
    assert.deepEqual(
      image.archive,
      candidate.images[role].archive,
      "Scan archive differs from candidate",
    );
    checkReport(await json(image.report), image.id, evidence.policy);
    const sbom = await json(image.sbom);
    assert.equal(sbom.bomFormat, "CycloneDX", "Unsupported SBOM format");
    assert.ok(Array.isArray(sbom.components) && sbom.components.length > 0, "Empty SBOM");
  }
  return evidence;
}
export function securityExec(program, args, options = {}) {
  return execFileSync(program, args, {
    maxBuffer: 128 * 1024 * 1024,
    timeout: 600000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
export function scannerUser(host = process) {
  assert.ok(
    ["linux", "darwin"].includes(host.platform),
    "Image scanning requires a Linux or macOS host with a numeric UID and GID",
  );
  const uid = host.getuid?.();
  const gid = host.getgid?.();
  assert.ok(
    Number.isSafeInteger(uid) && uid >= 0 && Number.isSafeInteger(gid) && gid >= 0,
    "Image scanning requires a numeric UID and GID",
  );
  return `${uid}:${gid}`;
}
export async function scanCandidate(root, candidate, output, run = securityExec) {
  const user = scannerUser();
  await mkdir(output, { recursive: true });
  const evidenceFile = path.join(output, "security.json");
  try {
    const ref = await evidenceReference(root, evidenceFile);
    await verifyScanEvidence(root, candidate, ref, { fresh: true });
    return ref;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const cache = path.join(output, "trivy-cache");
  await mkdir(cache, { recursive: true });
  const docker = (...args) =>
    run(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        user,
        "--mount",
        `type=bind,src=${root},dst=/workspace,readonly`,
        "--mount",
        `type=bind,src=${output},dst=/evidence`,
        toolchain.images.trivy,
        ...args,
      ],
      { cwd: root },
    );
  docker("image", "--cache-dir", "/evidence/trivy-cache", "--download-db-only");
  const databaseFile = path.join(output, "database.json");
  await writeFile(databaseFile, await readFile(path.join(cache, "db/metadata.json")));
  checkDatabase(JSON.parse(await readFile(databaseFile, "utf8")));
  const auditFile = path.join(output, "pnpm-audit.json");
  await securityReference(root, candidate.images.web.archive);
  run("docker", [
    "image",
    "load",
    "--input",
    securityPath(root, candidate.images.web.archive.path),
  ]);
  const loaded = run("docker", ["image", "inspect", "--format", "{{.Id}}", candidate.images.web.id])
    .toString()
    .trim();
  assert.equal(loaded, candidate.images.web.id, "Audit image differs from tested archive");
  const audit = run("docker", [
    "run",
    "--rm",
    "--read-only",
    "--entrypoint",
    "pnpm",
    "--workdir",
    "/app",
    candidate.images.web.id,
    "audit",
    "--prod",
    "--audit-level",
    "high",
    "--json",
  ]);
  checkAudit(JSON.parse(audit));
  await writeFile(auditFile, audit);
  const images = {};
  for (const role of ["web", "worker"]) {
    const image = candidate.images[role];
    await securityReference(root, image.archive);
    const common = [
      "image",
      "--cache-dir",
      "/evidence/trivy-cache",
      "--skip-db-update",
      "--scanners",
      "vuln",
      "--input",
      `/workspace/${image.archive.path}`,
    ];
    docker(...common, "--format", "json", "--output", `/evidence/${role}-vulnerabilities.json`);
    const report = JSON.parse(
      await readFile(path.join(output, `${role}-vulnerabilities.json`), "utf8"),
    );
    checkReport(report, image.id);
    docker(...common, "--format", "cyclonedx", "--output", `/evidence/${role}-sbom.json`);
    images[role] = {
      id: image.id,
      archive: image.archive,
      report: await evidenceReference(root, path.join(output, `${role}-vulnerabilities.json`)),
      sbom: await evidenceReference(root, path.join(output, `${role}-sbom.json`)),
    };
  }
  const evidence = securitySchema.parse({
    schemaVersion: 1,
    source: candidate.source,
    scannedAt: new Date().toISOString(),
    scanner: toolchain.images.trivy,
    policySha256: sha256(JSON.stringify(toolchain.policy)),
    policy: toolchain.policy,
    database: await evidenceReference(root, databaseFile),
    databaseSha256: await fileHash(path.join(cache, "db/trivy.db")),
    audit: await evidenceReference(root, auditFile),
    images,
    outcome: "passed",
  });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  const ref = await evidenceReference(root, evidenceFile);
  await verifyScanEvidence(root, candidate, ref, { fresh: true });
  return ref;
}
export async function cosignBinary() {
  const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const hash = toolchain.cosign.sha256[platform];
  assert.ok(hash, `Unsupported cosign host: ${platform}`);
  const directory = fileURLToPath(new URL("../artifacts/tools/", import.meta.url));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `cosign-${toolchain.cosign.version}-${platform}`);
  try {
    assert.equal(sha256(await readFile(file)), hash, "Cosign binary integrity mismatch");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = `${file}.${process.pid}.tmp`;
    securityExec("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "120",
      "--max-filesize",
      "268435456",
      "--output",
      temporary,
      `https://github.com/sigstore/cosign/releases/download/${toolchain.cosign.version}/cosign-${platform}`,
    ]);
    assert.equal(sha256(await readFile(temporary)), hash, "Cosign download integrity mismatch");
    await rename(temporary, file);
  }
  await chmod(file, 0o755);
  return file;
}
export function trustArguments(repository) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected repository is required");
  return [
    "--certificate-identity",
    `https://github.com/${repository}/.github/workflows/release.yml@refs/heads/main`,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
  ];
}
export function provenance(candidate, security, role) {
  return {
    buildDefinition: {
      buildType: "https://pstack.dev/release/v1",
      externalParameters: {
        source: candidate.source,
        role,
        archive: candidate.images[role].archive,
        security,
      },
      internalParameters: {},
    },
    runDetails: { builder: { id: "https://github.com/pstack/release" }, metadata: {} },
  };
}
export function checkAttestation(bytes, expected, reference, type) {
  const lines = bytes.toString().trim().split("\n").filter(Boolean);
  const envelopes = lines.flatMap((line) => {
    const value = JSON.parse(line);
    return Array.isArray(value) ? value : [value];
  });
  assert.ok(
    envelopes.some((envelope) => {
      const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
      return (
        statement.predicateType === type &&
        statement.subject?.some(
          (subject) => subject.digest?.sha256 === reference.split("@sha256:")[1],
        ) &&
        isDeepStrictEqual(statement.predicate, expected)
      );
    }),
    "Verified attestation does not bind expected evidence",
  );
}
export async function verifyReleaseSecurity(root, release, repository, options = {}) {
  const run = options.run ?? securityExec;
  const binary = options.binary ?? (await cosignBinary());
  const trust = trustArguments(repository);
  const candidate = JSON.parse(
    await readFile(await securityReference(root, release.candidate), "utf8"),
  );
  const evidence = await verifyScanEvidence(root, candidate, release.security, {
    now: options.now,
  });
  const directory = path.dirname(securityPath(root, release.security.path));
  const manifest = path.join(directory, "release.json");
  assert.deepEqual(
    JSON.parse(await readFile(manifest, "utf8")),
    release,
    "Signed manifest differs from release",
  );
  run(binary, ["verify-blob", ...trust, "--bundle", `${manifest}.sigstore.json`, manifest]);
  for (const role of ["web", "worker"]) {
    const image = release.images[role];
    assert.ok(
      image.reference.startsWith(`ghcr.io/${repository.toLowerCase()}-${role}@sha256:`),
      "Image repository differs from trusted repository",
    );
    run(binary, ["verify", ...trust, image.reference]);
    const sbom = JSON.parse(
      await readFile(await securityReference(root, evidence.images[role].sbom), "utf8"),
    );
    for (const [type, expected] of [
      ["cyclonedx", sbom],
      ["slsaprovenance1", provenance(candidate, release.security, role)],
    ]) {
      const verified = run(binary, [
        "verify-attestation",
        ...trust,
        "--type",
        type,
        image.reference,
      ]);
      checkAttestation(
        verified,
        expected,
        image.reference,
        type === "cyclonedx" ? "https://cyclonedx.org/bom" : "https://slsa.dev/provenance/v1",
      );
    }
  }
  const age = (options.now ?? Date.now()) - Date.parse(evidence.scannedAt);
  const policyHash = sha256(JSON.stringify(toolchain.policy));
  if (
    age > toolchain.policy.maxScanAgeHours * 3600000 ||
    evidence.scanner !== toolchain.images.trivy ||
    evidence.policySha256 !== policyHash
  ) {
    const output = path.join(
      root,
      "artifacts/security-rescan",
      `${release.security.sha256}-${policyHash}-${randomUUID()}`,
    );
    const current = await scanCandidate(root, candidate, output, run);
    return verifyScanEvidence(root, candidate, current, { fresh: true, now: options.now });
  }
  return evidence;
}
export async function signRelease(root, release, repository, run = securityExec) {
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    repository,
    "Signing requires the expected GitHub repository",
  );
  assert.equal(
    process.env.GITHUB_WORKFLOW_REF,
    `${repository}/.github/workflows/release.yml@refs/heads/main`,
    "Signing requires the release workflow on main",
  );
  assert.ok(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    "Release signing requires GitHub id-token: write",
  );
  const binary = await cosignBinary();
  const candidate = JSON.parse(
    await readFile(await securityReference(root, release.candidate), "utf8"),
  );
  const evidence = await verifyScanEvidence(root, candidate, release.security);
  const directory = path.dirname(securityPath(root, release.security.path));
  for (const role of ["web", "worker"]) {
    const ref = release.images[role].reference;
    run(binary, ["sign", "--yes", ref]);
    const predicate = path.join(directory, `${role}-provenance.json`);
    await writeFile(
      predicate,
      `${JSON.stringify(provenance(candidate, release.security, role), null, 2)}\n`,
    );
    for (const [type, file] of [
      ["cyclonedx", securityPath(root, evidence.images[role].sbom.path)],
      ["slsaprovenance1", predicate],
    ])
      run(binary, ["attest", "--yes", "--type", type, "--predicate", file, ref]);
  }
  const manifest = path.join(directory, "release.json");
  try {
    await readFile(`${manifest}.sigstore.json`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    run(binary, ["sign-blob", "--yes", "--bundle", `${manifest}.sigstore.json`, manifest]);
  }
  await verifyReleaseSecurity(root, release, repository, { run, binary });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { candidate: { type: "string" }, output: { type: "string" } },
  });
  assert.ok(values.candidate && values.output, "--candidate and --output required");
  const root = process.cwd();
  const candidate = JSON.parse(await readFile(path.resolve(values.candidate), "utf8"));
  const output = securityPath(root, values.output);
  process.stdout.write(`${JSON.stringify(await scanCandidate(root, candidate, output))}\n`);
}
