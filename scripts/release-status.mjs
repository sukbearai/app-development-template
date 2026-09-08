import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fullSha = /^[a-f0-9]{40}$/;
const versionTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?)$/;

export function validateReleaseIdentity(release, tag, expectedSha, tagCommit) {
  const match = tag.match(versionTag);
  assert.ok(match, "invalid application release tag");
  assert.equal(release.tag_name, tag, "release tag mismatch");
  assert.equal(release.draft, true, "only an unpublished draft can be resumed");
  assert.equal(release.prerelease, match[1].includes("-rc."), "GitHub prerelease flag differs from version");
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "invalid release ID");
  assert.match(release.target_commitish, fullSha, "draft must record a full immutable commit SHA");
  assert.equal(release.target_commitish, tagCommit, "reserved tag differs from draft source SHA");
  if (expectedSha !== undefined) {
    assert.match(expectedSha, fullSha, "action must return a full commit SHA");
    assert.equal(release.target_commitish, expectedSha, "draft differs from the original candidate SHA");
  }
  return { tag, sha: release.target_commitish, releaseId: release.id, version: match[1] };
}

async function resolveTagCommit(api, repository, tag) {
  let reference = await api(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (reference === null) return null;
  for (let depth = 0; depth < 10; depth += 1) {
    assert.match(reference.object.sha, fullSha, "invalid tag object SHA");
    if (reference.object.type === "commit") return reference.object.sha;
    assert.equal(reference.object.type, "tag", "release tag must reference a commit");
    reference = await api(`repos/${repository}/git/tags/${reference.object.sha}`);
  }
  throw new Error("release tag nesting exceeds the supported depth");
}

export async function resolveReleaseStatus(api, repository, tag, expectedSha) {
  assert.match(tag, versionTag, "invalid application release tag");
  const releases = await api(`repos/${repository}/releases?per_page=100`);
  const matches = releases.filter((release) => release.tag_name === tag);
  assert.equal(matches.length, 1, "expected exactly one matching release; retry requires its original draft");
  const tagCommit = await resolveTagCommit(api, repository, tag);
  assert.ok(tagCommit, "candidate tag has not been reserved");
  const result = validateReleaseIdentity(matches[0], tag, expectedSha, tagCommit);
  const commit = await api(`repos/${repository}/commits/${result.sha}`);
  assert.equal(commit.sha, result.sha, "candidate commit could not be resolved");
  const comparison = await api(`repos/${repository}/compare/${result.sha}...main`);
  assert.ok(["ahead", "identical"].includes(comparison.status), "candidate is not an ancestor of main");
  return result;
}

export async function preflightRelease(api, repository) {
  const pulls = await api(`repos/${repository}/pulls?state=closed&base=main&per_page=100&sort=updated&direction=desc`);
  const pending = pulls.filter((pull) => pull.merged_at && pull.labels.some((label) => label.name === "autorelease: pending"));
  assert.ok(pending.length <= 1, "multiple pending release PRs require separate recovery");
  const releases = await api(`repos/${repository}/releases?per_page=100`);
  for (const pull of pending) {
    assert.match(pull.merge_commit_sha, fullSha, "release PR has no immutable merge SHA");
    const file = await api(`repos/${repository}/contents/package.json?ref=${pull.merge_commit_sha}`);
    assert.equal(file.encoding, "base64", "unexpected package content encoding");
    const pkg = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    const tag = `v${pkg.version}`;
    assert.match(tag, versionTag, "invalid release PR version");
    const existing = await resolveTagCommit(api, repository, tag);
    if (existing !== null) assert.equal(existing, pull.merge_commit_sha, "existing tag points to another commit");
    const matches = releases.filter((release) => release.tag_name === tag);
    assert.equal(matches.length, 0, "release already exists; use explicit retry_tag to resume the original draft");
  }
  return { pending: pending.length };
}

export async function resolveRecoveryArtifact(api, repository, tag, runId, attempt) {
  assert.match(tag, versionTag, "invalid recovery tag");
  assert.match(runId, /^[1-9]\d*$/, "original run ID is required");
  assert.match(attempt, /^[1-9]\d*$/, "original run attempt is required");
  const run = await api(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
  assert.equal(String(run.id), runId, "recovery run ID mismatch");
  assert.equal(String(run.run_attempt), attempt, "recovery run attempt mismatch");
  assert.equal(run.status, "completed", "original release attempt must have finished");
  assert.equal(run.head_branch, 'main', 'Recovery requires the trusted main branch');
  assert.ok(['push', 'workflow_dispatch'].includes(run.event), 'Recovery cannot use pull request execution');
  assert.equal(run.path, ".github/workflows/release.yml", "recovery must use the release workflow");
  const workflow = await api(`repos/${repository}/actions/workflows/${run.workflow_id}`);
  assert.equal(workflow.path, ".github/workflows/release.yml", "original workflow path mismatch");
  const artifactName = `release-evidence-${tag}-${attempt}`;
  const pages = await api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = pages.artifacts.filter((artifact) => artifact.name === artifactName);
  assert.equal(matches.length, 1, "original release evidence artifact is missing or ambiguous");
  assert.equal(matches[0].expired, false, "original release evidence artifact has expired");
  assert.equal(String(matches[0].workflow_run.id), runId, "artifact belongs to another run");
  return { runId, artifactName };
}

function githubApi(endpoint) {
  try {
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    if (Array.isArray(pages[0])) return pages.flat();
    if (endpoint.includes("/artifacts?")) return { artifacts: pages.flatMap((page) => page.artifacts) };
    return pages[0];
  } catch (error) {
    if (endpoint.includes("/git/ref/tags/") && /HTTP 404/.test(String(error.stderr))) return null;
    throw new Error(`GitHub read failed for ${endpoint}`, { cause: error });
  }
}

export function parseReleaseStatusArgs(args) {
  const [command, ...flags] = args;
  assert.ok(["preflight", "resolve", "recovery"].includes(command), "expected preflight, resolve or recovery");
  const allowed = command === "recovery" ? ["--repo", "--tag", "--run-id", "--attempt"] : ["--repo", "--tag", "--sha"];
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    assert.ok(allowed.includes(key) && !Object.hasOwn(options, key), "unknown or duplicate argument");
    assert.ok(flags[index + 1] && !flags[index + 1].startsWith("--"), "argument value missing");
    options[key] = flags[index + 1];
  }
  assert.match(options["--repo"], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected owner/repository");
  if (command !== "preflight") assert.match(options["--tag"], versionTag);
  else assert.deepEqual(Object.keys(options), ["--repo"], "preflight accepts only --repo");
  if (options["--sha"]) assert.match(options["--sha"], fullSha);
  if (command === "recovery") {
    assert.match(options["--run-id"], /^[1-9]\d*$/, "original run ID is required");
    assert.match(options["--attempt"], /^[1-9]\d*$/, "original run attempt is required");
    return { command, repository: options["--repo"], tag: options["--tag"], runId: options["--run-id"], attempt: options["--attempt"] };
  }
  return { command, repository: options["--repo"], tag: options["--tag"], sha: options["--sha"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseReleaseStatusArgs(process.argv.slice(2));
    let result;
    if (args.command === "preflight") result = await preflightRelease(githubApi, args.repository);
    else if (args.command === "recovery") result = await resolveRecoveryArtifact(githubApi, args.repository, args.tag, args.runId, args.attempt);
    else result = await resolveReleaseStatus(githubApi, args.repository, args.tag, args.sha);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Release identity check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
