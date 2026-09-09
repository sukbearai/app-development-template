import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReleaseManifest,
  mandatoryReleaseChecks,
  migrationLedgerPath,
  requiredContainerChecks,
} from "../release-manifest.mjs";
import { evidenceReference, sha256, sourceIdentity } from "../verification-evidence.mjs";
import { toolchain } from "../release-security.mjs";

export async function releaseFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pstack-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, value) => {
    await writeFile(path.join(root, name), JSON.stringify(value));
    return path.join(root, name);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  await mkdir(path.dirname(path.join(root, migrationLedgerPath)), { recursive: true });
  await put(migrationLedgerPath, { migrations: [] });
  await put("package.json", { version: "0.1.0", packageManager: "pnpm@10.33.4" });
  await writeFile(path.join(root, ".gitignore"), "artifacts/\n");
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  const source = await sourceIdentity(root);
  await mkdir(path.join(root, "artifacts"));
  const ref = (name) => evidenceReference(root, path.join(root, name));
  const ids = { web: `sha256:${"1".repeat(64)}`, worker: `sha256:${"2".repeat(64)}` };
  const images = {};
  const published = {};
  for (const role of ["web", "worker"]) {
    const archive = `artifacts/${role}.tar`;
    await writeFile(path.join(root, archive), `${role} archive fixture`);
    images[role] = { id: ids[role], archive: await ref(archive), platform: "linux/arm64" };
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: ids[role] },
      layers: [],
    };
    const name = `artifacts/${role}-manifest.json`;
    await put(name, manifest);
    const manifestRef = await ref(name);
    published[role] = {
      reference: `ghcr.io/example/pstack-${role}@sha256:${manifestRef.sha256}`,
      id: ids[role],
      platform: "linux/arm64",
      manifest: manifestRef,
    };
  }
  const summaryName = "artifacts/summary.json";
  await put(summaryName, {
    source,
    status: "passed",
    checks: requiredContainerChecks,
    images: {
      web: { id: ids.web, platform: "linux/arm64" },
      worker: { id: ids.worker, platform: "linux/arm64" },
    },
  });
  const candidate = {
    schemaVersion: 1,
    source,
    createdAt: new Date().toISOString(),
    images,
    verification: await ref(summaryName),
  };
  const candidateFile = await put("artifacts/candidate.json", candidate);
  await writeFile(path.join(root, "artifacts/check.log"), "passed");
  const evidence = {
    schemaVersion: 1,
    runId: randomUUID(),
    source,
    startedAt: candidate.createdAt,
    finishedAt: candidate.createdAt,
    environment: { node: process.version, platform: "linux", arch: "arm64", ciRun: "1234" },
    status: "passed",
    checks: [],
  };
  for (const name of mandatoryReleaseChecks)
    evidence.checks.push({
      name,
      status: "passed",
      startedAt: candidate.createdAt,
      finishedAt: candidate.createdAt,
      durationMs: 1,
      evidence: [await ref(name === "test:containers" ? summaryName : "artifacts/check.log")],
    });
  const evidenceFile = await put("artifacts/index.json", evidence);
  const receipt = { schemaVersion: 1, source, images: published };
  const receiptFile = await put("artifacts/registry.json", receipt);
  const securityFile = await securityFixture({ candidate, put, ref });
  const outputFile = path.join(root, "artifacts/release.json");
  const options = { root, candidateFile, evidenceFile, receiptFile, securityFile, outputFile };
  const release = await createReleaseManifest(options);
  return { ...options, release, candidate, evidence, receipt, put, ref, hash: sha256 };
}

export async function securityFixture({ candidate, put, ref }) {
  const now = new Date();
  await put("artifacts/database.json", {
    UpdatedAt: now.toISOString(),
    NextUpdate: new Date(now.getTime() + 86400000).toISOString(),
  });
  await put("artifacts/audit.json", {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  });
  const images = {};
  for (const role of ["web", "worker"]) {
    const image = candidate.images[role];
    const report = `artifacts/${role}-vulnerabilities.json`;
    const sbom = `artifacts/${role}-sbom.json`;
    await put(report, {
      SchemaVersion: 2,
      ArtifactType: "container_image",
      Metadata: { ImageID: image.id },
      Results: [{ Class: "os-pkgs", Vulnerabilities: [] }],
    });
    await put(sbom, { bomFormat: "CycloneDX", components: [{ name: "fixture" }] });
    images[role] = {
      id: image.id,
      archive: image.archive,
      report: await ref(report),
      sbom: await ref(sbom),
    };
  }
  return put("artifacts/security.json", {
    schemaVersion: 1,
    source: candidate.source,
    scannedAt: now.toISOString(),
    scanner: toolchain.images.trivy,
    policySha256: sha256(JSON.stringify(toolchain.policy)),
    policy: toolchain.policy,
    database: await ref("artifacts/database.json"),
    databaseSha256: "f".repeat(64),
    audit: await ref("artifacts/audit.json"),
    images,
    outcome: "passed",
  });
}
