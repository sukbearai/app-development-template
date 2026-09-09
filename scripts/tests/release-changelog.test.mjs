import assert from "node:assert/strict";
import { test } from "node:test";
import { check, resolveConfig } from "prettier";
import { formatReleasePullRequest } from "../format-release-pr.mjs";

const repository = "owner/application";
const branch = "release-please--branches--main--components--pstack-x";
const originalSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const generated = [{ number: 2, headBranchName: branch, baseBranchName: "main" }];
const options = await resolveConfig(new URL("../../CHANGELOG.md", import.meta.url));
const raw = "# Changelog\n\n## 0.2.0 (2026-09-09)\n\n\n### Features\n\n* 增加发行验证\n";

function fixture() {
  const pull = {
    state: "open",
    head: { repo: { full_name: repository }, ref: branch, sha: originalSha },
    base: { repo: { full_name: repository }, ref: "main" },
    labels: [{ name: "autorelease: pending" }],
  };
  let content = raw;
  let currentHead = originalSha;
  const writes = [];
  const api = async (endpoint, body) => {
    if (endpoint === `repos/${repository}/pulls/2`) return structuredClone(pull);
    if (endpoint === `repos/${repository}/contents/CHANGELOG.md?ref=${pull.head.sha}`)
      return { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") };
    assert.equal(endpoint, "graphql");
    const { input } = body.variables;
    if (input.expectedHeadOid !== currentHead) throw new Error("head changed");
    assert.deepEqual(input.branch, { repositoryNameWithOwner: repository, branchName: branch });
    assert.deepEqual(Object.keys(input.fileChanges), ["additions"]);
    assert.equal(input.fileChanges.additions.length, 1);
    const [file] = input.fileChanges.additions;
    assert.equal(file.path, "CHANGELOG.md");
    writes.push(input);
    content = Buffer.from(file.contents, "base64").toString("utf8");
    currentHead = nextSha;
    pull.head.sha = nextSha;
    return { data: { createCommitOnBranch: { commit: { oid: nextSha } } } };
  };
  return {
    api,
    pull,
    writes,
    drift: () => {
      currentHead = nextSha;
    },
    content: () => content,
  };
}

test("normalizes generated Markdown, preserves release text and writes once across retries", async () => {
  const f = fixture();
  assert.equal(await check(raw, { ...options, filepath: "CHANGELOG.md" }), false);
  assert.deepEqual(await formatReleasePullRequest(f.api, repository, generated, options), {
    changed: true,
    sha: nextSha,
  });
  assert.equal(await check(f.content(), { ...options, filepath: "CHANGELOG.md" }), true);
  assert.ok(f.content().includes("## 0.2.0 (2026-09-09)"));
  assert.ok(f.content().includes("- 增加发行验证"));
  assert.deepEqual(await formatReleasePullRequest(f.api, repository, generated, options), {
    changed: false,
    sha: nextSha,
  });
  assert.equal(f.writes.length, 1);
});

test("rejects head races without committing to the moved branch", async () => {
  const f = fixture();
  f.drift();
  await assert.rejects(
    formatReleasePullRequest(f.api, repository, generated, options),
    /head changed/,
  );
  assert.equal(f.content(), raw);
  assert.equal(f.writes.length, 0);
});

test("refuses closed, forked, retargeted and unrelated PRs before writing", async () => {
  for (const change of [
    (pull) => {
      pull.state = "closed";
    },
    (pull) => {
      pull.head.repo.full_name = "other/application";
    },
    (pull) => {
      pull.base.repo.full_name = "other/application";
    },
    (pull) => {
      pull.head.ref = "feature";
    },
    (pull) => {
      pull.base.ref = "develop";
    },
    (pull) => {
      pull.labels = [];
    },
  ]) {
    const f = fixture();
    change(f.pull);
    await assert.rejects(formatReleasePullRequest(f.api, repository, generated, options));
    assert.equal(f.writes.length, 0);
  }
});

test("requires action output identifying the single configured release PR", async () => {
  const unexpectedRead = () => {
    throw new Error("must not access GitHub");
  };
  assert.deepEqual(await formatReleasePullRequest(unexpectedRead, repository, [], options), {
    changed: false,
  });
  for (const prs of [
    null,
    [generated[0], generated[0]],
    [{ ...generated[0], number: -1 }],
    [{ ...generated[0], headBranchName: "main" }],
    [{ ...generated[0], baseBranchName: "develop" }],
  ])
    await assert.rejects(formatReleasePullRequest(unexpectedRead, repository, prs, options));
});
