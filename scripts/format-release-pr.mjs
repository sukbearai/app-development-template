import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const releaseBranch = "release-please--branches--main--components--pstack-x";
const mutation = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

export async function formatReleasePullRequest(api, repository, prs, options) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "invalid repository");
  assert.ok(Array.isArray(prs) && prs.length <= 1, "expected one root release PR");
  if (prs.length === 0) return { changed: false };
  const [generated] = prs;
  assert.ok(Number.isSafeInteger(generated.number) && generated.number > 0, "invalid PR number");
  assert.equal(generated.headBranchName, releaseBranch, "unexpected generated release branch");
  assert.equal(generated.baseBranchName, "main", "unexpected generated release base");
  const pull = await api(`repos/${repository}/pulls/${generated.number}`);
  assert.equal(pull.state, "open", "release PR is no longer open");
  assert.equal(
    pull.head.repo.full_name,
    repository,
    "release PR head must belong to this repository",
  );
  assert.equal(
    pull.base.repo.full_name,
    repository,
    "release PR base must belong to this repository",
  );
  assert.equal(pull.head.ref, releaseBranch, "release PR branch changed");
  assert.equal(pull.base.ref, "main", "release PR base changed");
  assert.ok(
    pull.labels.some((label) => label.name === "autorelease: pending"),
    "missing release label",
  );
  assert.match(pull.head.sha, /^[a-f0-9]{40}$/, "invalid release PR head SHA");
  const file = await api(`repos/${repository}/contents/CHANGELOG.md?ref=${pull.head.sha}`);
  assert.equal(file.type, "file", "changelog must be a regular file");
  assert.equal(file.encoding, "base64", "unexpected changelog encoding");
  const original = Buffer.from(file.content, "base64").toString("utf8");
  const formatted = await format(original, {
    ...options,
    filepath: "CHANGELOG.md",
    parser: "markdown",
  });
  if (formatted === original) return { changed: false, sha: pull.head.sha };
  const result = await api("graphql", {
    query: mutation,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: releaseBranch },
        expectedHeadOid: pull.head.sha,
        message: { headline: "chore: 格式化发行更新日志" },
        fileChanges: {
          additions: [
            { path: "CHANGELOG.md", contents: Buffer.from(formatted).toString("base64") },
          ],
        },
      },
    },
  });
  assert.ok(!result.errors?.length, "GitHub rejected the changelog commit");
  const sha = result.data?.createCommitOnBranch?.commit?.oid;
  assert.match(sha, /^[a-f0-9]{40}$/, "GitHub did not return a changelog commit");
  return { changed: true, sha };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const api = async (endpoint, body) => {
    const args = ["api", endpoint];
    if (body) args.push("--input", "-");
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        input: body ? JSON.stringify(body) : undefined,
        stdio: ["pipe", "pipe", "inherit"],
      }),
    );
  };
  const options = await resolveConfig(new URL("../CHANGELOG.md", import.meta.url));
  const result = await formatReleasePullRequest(
    api,
    process.env.GITHUB_REPOSITORY,
    JSON.parse(process.env.RELEASE_PRS),
    options,
  );
  console.log(JSON.stringify(result));
}
