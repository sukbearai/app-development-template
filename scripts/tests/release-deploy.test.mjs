import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentPlan, verifyTransition } from "../release-deploy.mjs";
import { releaseFixture } from "./release-fixture.mjs";

test("RC increments and promotion use the version tool ordering", () => {
  const compatibility = {
    migrationLedgerSha256: "a".repeat(64),
    recoveryProtocol: "pstack-recovery-v2",
    rollbackVersions: [],
  };
  const release = (version) => ({ version, compatibility });
  verifyTransition(release("1.2.3-rc.1"), release("1.2.3-rc.2"), false);
  verifyTransition(release("1.2.3-rc.2"), release("1.2.3"), false);
  assert.throws(
    () => verifyTransition(release("1.2.3-rc.2"), release("1.2.3-rc.1"), false),
    /rollback/,
  );
  assert.throws(() => verifyTransition(release("1.2.3"), release("1.2.3-rc.2"), false), /rollback/);
});

async function publishedApi(fixture, mutation = null) {
  const ref = await fixture.ref("artifacts/release.json");
  const remote = {
    id: 42,
    draft: false,
    tag_name: fixture.release.tag,
    published_at: fixture.release.createdAt,
    assets: [{ name: "release.json", size: ref.bytes, digest: `sha256:${ref.sha256}` }],
  };
  if (mutation === "draft") remote.draft = true;
  if (mutation === "asset") remote.assets[0].digest = `sha256:${"f".repeat(64)}`;
  if (mutation === "missing asset") remote.assets = [];
  return (endpoint) =>
    endpoint.includes("/commits/")
      ? { sha: mutation === "SHA" ? "f".repeat(40) : fixture.release.source.gitSha }
      : remote;
}
test("published release produces digest-pinned plan without deployment writes", async (t) => {
  const f = await releaseFixture(t);
  const plan = await deploymentPlan(
    f.root,
    f.outputFile,
    "example/pstack",
    null,
    false,
    await publishedApi(f),
  );
  assert.equal(plan.operation, "plan");
  assert.equal(plan.environment.PSTACK_WEB_IMAGE, f.release.images.web.reference);
  assert.equal(plan.releaseId, 42);
});
for (const mutation of ["draft", "asset", "missing asset", "SHA"]) {
  test(`deployment refuses published release with invalid ${mutation}`, async (t) => {
    const f = await releaseFixture(t);
    await assert.rejects(
      deploymentPlan(
        f.root,
        f.outputFile,
        "example/pstack",
        null,
        false,
        await publishedApi(f, mutation),
      ),
    );
  });
}
test("rollback requires explicit version, migration ledger and recovery protocol compatibility", async (t) => {
  const f = await releaseFixture(t);
  const current = structuredClone(f.release);
  current.version = "0.2.0";
  assert.throws(() => verifyTransition(current, f.release, false), /rollback/);
  assert.throws(() => verifyTransition(current, f.release, true), /explicitly verified/);
  current.compatibility.rollbackVersions.push(f.release.version);
  verifyTransition(current, f.release, true);
  current.compatibility.migrationLedgerSha256 = "e".repeat(64);
  assert.throws(() => verifyTransition(current, f.release, true), /Migration ledger/);
  current.compatibility.recoveryProtocol = "pstack-recovery-v1";
  assert.throws(() => verifyTransition(current, f.release, true), /recovered-worker/);
});
test("downloaded archive tampering prevents a deployment plan", async (t) => {
  const f = await releaseFixture(t);
  await f.put(f.candidate.images.web.archive.path, "changed");
  await assert.rejects(
    deploymentPlan(f.root, f.outputFile, "example/pstack", null, false, await publishedApi(f)),
    /content mismatch/,
  );
});
