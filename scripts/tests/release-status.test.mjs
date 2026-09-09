import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseReleaseStatusArgs,
  preflightRelease,
  resolveRecoveryArtifact,
  resolveReleaseStatus,
  validateReleaseIdentity,
} from "../release-status.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const tag = "v0.1.1";
const prefix = "repos/owner/application";
const release = { id: 73, tag_name: tag, target_commitish: sha, draft: true, prerelease: false };

function fixture() {
  const responses = new Map([
    [`${prefix}/releases?per_page=100`, [structuredClone(release)]],
    [`${prefix}/git/ref/tags/${tag}`, { object: { type: "commit", sha } }],
    [`${prefix}/commits/${sha}`, { sha }],
    [`${prefix}/compare/${sha}...main`, { status: "ahead" }],
    [`${prefix}/pulls?state=closed&base=main&per_page=100&sort=updated&direction=desc`, []],
  ]);
  const api = async (path) => {
    assert.ok(responses.has(path), `unexpected GitHub API read ${path}`);
    return responses.get(path);
  };
  return { responses, api };
}

test("resolves the authenticated draft and commit rather than the current branch head", async () => {
  const { api } = fixture();
  assert.deepEqual(await resolveReleaseStatus(api, "owner/application", tag, sha), {
    tag,
    sha,
    releaseId: 73,
    version: "0.1.1",
  });
  assert.deepEqual(await resolveReleaseStatus(api, "owner/application", tag), {
    tag,
    sha,
    releaseId: 73,
    version: "0.1.1",
  });
});

test("resolves annotated tag objects to their commit", async () => {
  const { api, responses } = fixture();
  responses.set(`${prefix}/git/ref/tags/${tag}`, { object: { type: "tag", sha: otherSha } });
  responses.set(`${prefix}/git/tags/${otherSha}`, { object: { type: "commit", sha } });
  assert.equal((await resolveReleaseStatus(api, "owner/application", tag)).sha, sha);
});

test("rejects release drift and publication before retry", () => {
  for (const changed of [
    { ...release, draft: false },
    { ...release, prerelease: true },
    { ...release, target_commitish: "main" },
    { ...release, target_commitish: otherSha },
    { ...release, tag_name: "v0.1.2" },
    { ...release, id: -1 },
  ])
    assert.throws(() => validateReleaseIdentity(changed, tag, sha, sha));
  assert.throws(() => validateReleaseIdentity(release, tag, otherSha, sha), /original candidate/);
  const rc = { ...release, tag_name: "v0.1.1-rc.1", prerelease: true };
  assert.equal(validateReleaseIdentity(rc, rc.tag_name, sha, sha).version, "0.1.1-rc.1");
});

test("rejects missing, ambiguous, moved and unrelated candidates", async () => {
  for (const [path, value] of [
    [`${prefix}/releases?per_page=100`, []],
    [`${prefix}/releases?per_page=100`, [release, release]],
    [`${prefix}/git/ref/tags/${tag}`, null],
    [`${prefix}/git/ref/tags/${tag}`, { object: { type: "commit", sha: otherSha } }],
    [`${prefix}/compare/${sha}...main`, { status: "diverged" }],
    [`${prefix}/compare/${sha}...main`, { status: "behind" }],
    [`${prefix}/commits/${sha}`, { sha: otherSha }],
  ]) {
    const { api, responses } = fixture();
    responses.set(path, value);
    await assert.rejects(resolveReleaseStatus(api, "owner/application", tag));
  }
});

test("preflight refuses an existing mismatched tag before release-please can ignore it", async () => {
  const { api, responses } = fixture();
  const pending = {
    number: 12,
    merged_at: "2026-09-08T00:00:00Z",
    merge_commit_sha: sha,
    labels: [{ name: "autorelease: pending" }],
  };
  const pullsPath = `${prefix}/pulls?state=closed&base=main&per_page=100&sort=updated&direction=desc`;
  responses.set(pullsPath, [pending]);
  responses.set(`${prefix}/contents/package.json?ref=${sha}`, {
    encoding: "base64",
    content: Buffer.from(JSON.stringify({ version: "0.1.1" })).toString("base64"),
  });
  responses.set(`${prefix}/releases?per_page=100`, []);
  responses.set(`${prefix}/git/ref/tags/${tag}`, null);
  assert.deepEqual(await preflightRelease(api, "owner/application"), { pending: 1 });
  responses.set(`${prefix}/git/ref/tags/${tag}`, { object: { type: "commit", sha: otherSha } });
  await assert.rejects(preflightRelease(api, "owner/application"), /another commit/);
  responses.set(`${prefix}/git/ref/tags/${tag}`, { object: { type: "commit", sha } });
  assert.deepEqual(await preflightRelease(api, "owner/application"), { pending: 1 });
  responses.set(`${prefix}/releases?per_page=100`, [release]);
  await assert.rejects(preflightRelease(api, "owner/application"), /explicit retry_tag/);
  responses.set(pullsPath, [pending, { ...pending, number: 13 }]);
  await assert.rejects(preflightRelease(api, "owner/application"), /multiple pending/);
});

test("argument validation rejects malformed identity before making API calls", () => {
  assert.deepEqual(
    parseReleaseStatusArgs(["resolve", "--repo", "owner/application", "--tag", tag, "--sha", sha]),
    { command: "resolve", repository: "owner/application", tag, sha },
  );
  for (const args of [
    [],
    ["publish"],
    ["resolve", "--repo", "owner/application", "--tag", "main"],
    ["preflight", "--repo", "owner/application", "--unknown", "x"],
    ["preflight", "--repo", "owner/application", "--repo", "owner/other"],
    ["resolve", "--repo", "owner/application", "--tag", tag, "--sha", "main"],
    ["resolve", "--repo", "owner/application", "--tag"],
    ["recovery", "--repo", "owner/application", "--tag", tag, "--attempt", "1"],
    ["recovery", "--repo", "owner/application", "--tag", tag, "--run-id", "15", "--attempt", "0"],
  ])
    assert.throws(() => parseReleaseStatusArgs(args));
});

test("recovery binds to the original release workflow attempt and nonexpired artifact", async () => {
  const { api, responses } = fixture();
  const runPath = `${prefix}/actions/runs/150/attempts/2`;
  const workflowPath = `${prefix}/actions/workflows/34`;
  const artifactsPath = `${prefix}/actions/runs/150/artifacts?per_page=100`;
  const run = {
    id: 150,
    run_attempt: 2,
    workflow_id: 34,
    path: ".github/workflows/release.yml",
    status: "completed",
    head_branch: "main",
    event: "push",
  };
  const artifact = { name: `release-evidence-${tag}-2`, expired: false, workflow_run: { id: 150 } };
  responses.set(runPath, run);
  responses.set(workflowPath, { path: ".github/workflows/release.yml" });
  responses.set(artifactsPath, { artifacts: [artifact] });
  assert.deepEqual(await resolveRecoveryArtifact(api, "owner/application", tag, "150", "2"), {
    runId: "150",
    artifactName: artifact.name,
  });
  for (const changed of [
    { ...run, path: ".github/workflows/ci.yml" },
    { ...run, run_attempt: 3 },
    { ...run, head_branch: "untrusted" },
    { ...run, event: "pull_request" },
    { ...run, id: 151 },
    { ...run, status: "in_progress" },
  ]) {
    responses.set(runPath, changed);
    await assert.rejects(resolveRecoveryArtifact(api, "owner/application", tag, "150", "2"));
  }
  responses.set(runPath, run);
  for (const artifacts of [
    [],
    [artifact, artifact],
    [{ ...artifact, expired: true }],
    [{ ...artifact, workflow_run: { id: 151 } }],
    [{ ...artifact, name: `release-evidence-${tag}-1` }],
  ]) {
    responses.set(artifactsPath, { artifacts });
    await assert.rejects(resolveRecoveryArtifact(api, "owner/application", tag, "150", "2"));
  }
});

test("workflow ties publishing to an exact checked candidate and explicit retry", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(
    workflow,
    /googleapis\/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071/,
  );
  assert.match(
    workflow,
    /actions\/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349/,
  );
  assert.match(workflow, /token: \$\{\{ steps\.app\.outputs\.token \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.sha \}\}/);
  assert.match(workflow, /node scripts\/release-version-check\.mjs --candidate/);
  assert.match(workflow, /pnpm --silent pr:verify --release --json/);
  assert.match(workflow, /PSTACK_RELEASE_OUTPUT: artifacts\/release-candidate/);
  assert.match(workflow, /--tag "\$RETRY_TAG"/);
  assert.match(workflow, /--sha "\$RELEASE_SHA"/);
  assert.match(workflow, /if: success\(\) && steps\.verify\.outputs\.evidence != ''/);
  assert.match(workflow, /node scripts\/release-publish\.mjs .* --apply/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(workflow, /run-id: \$\{\{ needs\.prepare\.outputs\.recovery_run \}\}/);
  assert.match(workflow, /name: \$\{\{ needs\.prepare\.outputs\.recovery_artifact \}\}/);
  assert.match(
    workflow,
    /Verify source and the candidate images\n\s+if: needs\.prepare\.outputs\.recovery_run == ''/,
  );
  assert.match(workflow, /pnpm db:migrate\n\s+if: needs\.prepare\.outputs\.recovery_run == ''/);
  assert.match(
    workflow,
    /pnpm admin:bootstrap\n\s+if: needs\.prepare\.outputs\.recovery_run == ''/,
  );
  assert.doesNotMatch(workflow, /github\.sha/);
  const commands = [...workflow.matchAll(/^\s*(?:- )?run: (?:\||[^\n]+)/gm)].map(
    (entry) => entry[0],
  );
  assert.ok(
    commands.every((command) => !command.includes("${{")),
    "run commands must use environment variables for untrusted expressions",
  );
});
