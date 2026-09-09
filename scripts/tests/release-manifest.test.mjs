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
    await assert.rejects(createRelease(f.root, f.candidateFile, f.evidenceFile, f.receiptFile));
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
  await assert.rejects(
    createRelease(f.root, f.candidateFile, f.evidenceFile, f.receiptFile),
    /Container verification failed/,
  );
  summary.status = "passed";
  summary.checks = ["one", "two", "three", "four", "five"];
  await f.put("artifacts/summary.json", summary);
  f.candidate.verification = await f.ref("artifacts/summary.json");
  f.evidence.checks.find((check) => check.name === "test:containers").evidence = [
    f.candidate.verification,
  ];
  await f.put("artifacts/candidate.json", f.candidate);
  await f.put("artifacts/index.json", f.evidence);
  await assert.rejects(
    createRelease(f.root, f.candidateFile, f.evidenceFile, f.receiptFile),
    /Missing container behavior check/,
  );
});
test("publisher preflight rejects changed checkout before publishing", async (t) => {
  const f = await releaseFixture(t);
  await f.put("untracked-source.json", { changed: true });
  await assert.rejects(verifyCandidateInputs(f), /checkout source mismatch/);
});
