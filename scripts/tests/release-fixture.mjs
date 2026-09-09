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
  const outputFile = path.join(root, "artifacts/release.json");
  const options = { root, candidateFile, evidenceFile, receiptFile, outputFile };
  const release = await createReleaseManifest(options);
  return { ...options, release, candidate, evidence, receipt, put, ref, hash: sha256 };
}
