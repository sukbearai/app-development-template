import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createRelease,
  createReleaseManifest,
  verifyCandidateInputs,
  verifyRelease,
} from "../release-manifest.mjs";
import { releaseFixture } from "./release-fixture.mjs";

async function legacyRelease(t, version = "0.2.3") {
  const f = await releaseFixture(t);
  f.release.schemaVersion = 1;
  f.release.version = version;
  f.release.tag = `v${version}`;
  f.evidence.checks = f.evidence.checks.filter((check) => check.name !== "conventions:check");
  await saveReleaseEvidence(f);
  return f;
}
async function saveReleaseEvidence(f) {
  await f.put("artifacts/index.json", f.evidence);
  f.release.evidence = await f.ref("artifacts/index.json");
  await f.put("artifacts/release.json", f.release);
}

for (const version of ["0.2.2", "0.2.3-rc.1", "0.2.3"]) {
  test(`published v1 release ${version} retains its original gates after conventions is introduced`, async (t) => {
    const f = await legacyRelease(t, version);
    assert.deepEqual(await verifyRelease(f.outputFile, f.root), f.release);
  });
}

test("legacy releases still require every historical gate", async (t) => {
  const f = await legacyRelease(t);
  const checks = f.evidence.checks;
  for (const omitted of checks) {
    f.evidence.checks = checks.filter((check) => check.name !== omitted.name);
    await saveReleaseEvidence(f);
    await assert.rejects(verifyRelease(f.outputFile, f.root), {
      message: `Missing mandatory release check: ${omitted.name}`,
    });
  }
});

test("legacy release archives retain their integrity checks", async (t) => {
  const f = await legacyRelease(t);
  await f.put(f.candidate.images.web.archive.path, "tampered");
  await assert.rejects(verifyRelease(f.outputFile, f.root), /Release file content mismatch/);
});

for (const version of ["0.2.4-rc.1", "0.2.4", "0.10.0", "1.0.0"]) {
  test(`release ${version} cannot downgrade to legacy schema v1`, async (t) => {
    const f = await legacyRelease(t, version);
    await assert.rejects(verifyRelease(f.outputFile, f.root), /schema v1 is limited/);
  });
}

test("new manifests and candidate preflight cannot omit conventions through legacy compatibility", async (t) => {
  const f = await releaseFixture(t);
  assert.equal(f.release.schemaVersion, 2);
  f.evidence.checks = f.evidence.checks.filter((check) => check.name !== "conventions:check");
  await saveReleaseEvidence(f);
  await assert.rejects(
    verifyRelease(f.outputFile, f.root),
    /Missing mandatory release check: conventions:check/,
  );
  await assert.rejects(
    verifyCandidateInputs(f),
    /Missing mandatory release check: conventions:check/,
  );
  await assert.rejects(createRelease(f), /Missing mandatory release check: conventions:check/);

  f.release.schemaVersion = 1;
  await f.put("artifacts/release.json", f.release);
  assert.deepEqual(await verifyRelease(f.outputFile, f.root), f.release);
  await assert.rejects(
    verifyCandidateInputs(f),
    /Missing mandatory release check: conventions:check/,
  );
  await assert.rejects(createRelease(f), /Missing mandatory release check: conventions:check/);
});

test("release manifest closes source, gates, archives and raw registry config identities", async (t) => {
  const fixture = await releaseFixture(t);
  assert.deepEqual(await verifyRelease(fixture.outputFile, fixture.root), fixture.release);
  assert.deepEqual(await createReleaseManifest(fixture), fixture.release);
  assert.deepEqual(fixture.release.compatibility.rollbackVersions, []);
  assert.equal((await verifyCandidateInputs(fixture)).index.status, "passed");
});
for (const mutation of [
  "missing gate",
  "dirty source",
  "wrong source",
  "failed summary",
  "archive tamper",
  "false receipt",
  "wrong config",
  "missing evidence",
]) {
  test(`release refuses ${mutation}`, async (t) => {
    const f = await releaseFixture(t);
    if (mutation === "missing gate") {
      f.evidence.checks.pop();
      await f.put("artifacts/index.json", f.evidence);
    }
    if (mutation === "dirty source") {
      f.candidate.source.dirty = true;
      await f.put("artifacts/candidate.json", f.candidate);
    }
    if (mutation === "wrong source") {
      f.evidence.source.gitSha = "f".repeat(40);
      await f.put("artifacts/index.json", f.evidence);
    }
    if (mutation === "failed summary") await f.put("artifacts/summary.json", { status: "failed" });
    if (mutation === "archive tamper") await f.put(f.candidate.images.web.archive.path, "tampered");
    if (mutation === "false receipt") {
      f.receipt.images.web.reference = `ghcr.io/example/web@sha256:${"f".repeat(64)}`;
      await f.put("artifacts/registry.json", f.receipt);
    }
    if (mutation === "wrong config") {
      const name = f.receipt.images.web.manifest.path;
      await f.put(name, {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: `sha256:${"f".repeat(64)}` },
        layers: [],
      });
      f.receipt.images.web.manifest = await f.ref(name);
      f.receipt.images.web.reference = `ghcr.io/example/web@sha256:${f.receipt.images.web.manifest.sha256}`;
      await f.put("artifacts/registry.json", f.receipt);
    }
    if (mutation === "missing evidence") {
      f.evidence.checks[0].evidence[0].path = "artifacts/missing.log";
      await f.put("artifacts/index.json", f.evidence);
    }
    await assert.rejects(createRelease(f));
  });
}
test("release rejects changed manifest without overwriting it", async (t) => {
  const f = await releaseFixture(t);
  await writeFile(f.outputFile, "existing release");
  await assert.rejects(createReleaseManifest(f), /overwrite/);
  assert.equal(await readFile(f.outputFile, "utf8"), "existing release");
});
test("release refuses coherent failed or incomplete raw container evidence", async (t) => {
  const f = await releaseFixture(t);
  const summary = JSON.parse(await readFile(`${f.root}/artifacts/summary.json`, "utf8"));
  summary.status = "failed";
  await f.put("artifacts/summary.json", summary);
  f.candidate.verification = await f.ref("artifacts/summary.json");
  f.evidence.checks.find((check) => check.name === "test:containers").evidence = [
    f.candidate.verification,
  ];
  await f.put("artifacts/candidate.json", f.candidate);
  await f.put("artifacts/index.json", f.evidence);
  await assert.rejects(createRelease(f), /Container verification failed/);
  summary.status = "passed";
  summary.checks = ["one", "two", "three", "four", "five"];
  await f.put("artifacts/summary.json", summary);
  f.candidate.verification = await f.ref("artifacts/summary.json");
  f.evidence.checks.find((check) => check.name === "test:containers").evidence = [
    f.candidate.verification,
  ];
  await f.put("artifacts/candidate.json", f.candidate);
  await f.put("artifacts/index.json", f.evidence);
  await assert.rejects(createRelease(f), /Missing container behavior check/);
});
test("publisher preflight rejects changed checkout before publishing", async (t) => {
  const f = await releaseFixture(t);
  await f.put("untracked-source.json", { changed: true });
  await assert.rejects(verifyCandidateInputs(f), /checkout source mismatch/);
});

test("release requires security evidence and rejects vulnerable or tampered reports", async (t) => {
  const f = await releaseFixture(t);
  await assert.rejects(
    createRelease({ ...f, securityFile: undefined }),
    /Security evidence is required/,
  );
  await f.put("artifacts/web-vulnerabilities.json", {
    SchemaVersion: 2,
    ArtifactType: "container_image",
    Metadata: { ImageID: f.candidate.images.web.id },
    Results: [
      {
        Class: "os-pkgs",
        Vulnerabilities: [{ Severity: "HIGH", VulnerabilityID: "CVE-fixture", PkgName: "fixture" }],
      },
    ],
  });
  await assert.rejects(verifyRelease(f.outputFile, f.root), /Security evidence content mismatch/);
  const security = JSON.parse(await readFile(f.securityFile, "utf8"));
  security.images.web.report = await f.ref("artifacts/web-vulnerabilities.json");
  await f.put("artifacts/security.json", security);
  await assert.rejects(createRelease(f), /Blocked vulnerability/);
});

test("a rollback allowlist cannot be added without a matching proof", async (t) => {
  const f = await releaseFixture(t);
  f.release.compatibility.rollbackVersions = ["0.0.9"];
  await f.put("artifacts/release.json", f.release);
  await assert.rejects(verifyRelease(f.outputFile, f.root));
  await assert.rejects(
    createRelease({ ...f, previousFile: f.outputFile }),
    /Rollback proof requires a previous release/,
  );
});
