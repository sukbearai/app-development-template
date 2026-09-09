#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const engineeringFiles = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/verify-published-deployment.yml",
  "docs/deployment-execution.md",
  "docs/engineering-tools.md",
  "scripts/ci-plan.mjs",
  "scripts/tests/ci-plan.test.mjs",
  "scripts/published-deployment-checks.mjs",
  "scripts/published-deployment-support.mjs",
  "scripts/published-deployment-target.mjs",
  "scripts/rehearsal-process.py",
  "scripts/test-published-deployment.mjs",
  "scripts/tests/published-deployment.test.mjs",
  "scripts/tests/rehearsal-process.test.py",
]);
const versionFiles = new Set(["package.json", ".release-please-manifest.json", "CHANGELOG.md"]);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;
function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}
function commit(root, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Missing or invalid event commit");
  return git(root, "rev-parse", "--verify", `${sha}^{commit}`);
}
function tree(root, sha) {
  return git(root, "rev-parse", "--verify", `${commit(root, sha)}^{tree}`);
}
function versionOnly(root, base, head, file) {
  if (file === "CHANGELOG.md") return true;
  const before = JSON.parse(git(root, "show", `${base}:${file}`));
  const after = JSON.parse(git(root, "show", `${head}:${file}`));
  const key = file === "package.json" ? "version" : ".";
  if (!versionPattern.test(before[key]) || !versionPattern.test(after[key])) return false;
  if (file !== "package.json" && !isDeepStrictEqual(Object.keys(before), ["."])) return false;
  delete before[key];
  delete after[key];
  return isDeepStrictEqual(before, after);
}
export function changeScope(root, base, head) {
  commit(root, base);
  commit(root, head);
  git(root, "merge-base", "--is-ancestor", base, head);
  const files = git(root, "diff", "--name-only", "--no-renames", "-z", base, head, "--")
    .split("\0")
    .filter(Boolean);
  if (
    files.length &&
    files.every((file) => versionFiles.has(file) && versionOnly(root, base, head, file))
  )
    return { scope: "version", files };
  if (files.length && files.every((file) => engineeringFiles.has(file)))
    return { scope: "engineering", files };
  return { scope: "full", files };
}
export async function reusableRun(root, head, repository, api) {
  const pulls = await api(`repos/${repository}/commits/${head}/pulls?per_page=100`);
  for (const pull of pulls) {
    if (
      !pull.merged_at ||
      pull.merge_commit_sha !== head ||
      pull.base?.ref !== "main" ||
      pull.base.repo?.full_name !== repository ||
      pull.head?.repo?.full_name !== repository
    )
      continue;
    let prTree;
    try {
      prTree = tree(root, pull.head.sha);
    } catch {
      if (!/^[a-f0-9]{40}$/.test(pull.head.sha ?? "")) continue;
      const object = await api(`repos/${repository}/git/commits/${pull.head.sha}`);
      if (object.sha !== pull.head.sha) continue;
      prTree = object.tree?.sha;
    }
    if (prTree !== tree(root, head)) continue;
    const result = await api(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
    );
    const run = result.workflow_runs.find(
      (candidate) =>
        candidate.event === "pull_request" &&
        candidate.name === "Verify template" &&
        candidate.path === ".github/workflows/ci.yml" &&
        candidate.head_sha === pull.head.sha &&
        candidate.head_repository?.full_name === repository,
    );
    if (run?.status === "completed" && run.conclusion === "success")
      return {
        id: run.id,
        url: run.html_url,
        attempt: run.run_attempt,
        head: run.head_sha,
        tree: tree(root, head),
        pullRequest: pull.number,
      };
  }
  return null;
}
export async function ciPlan(root, eventName, event, head, repository, api) {
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  const plan = {
    schemaVersion: 1,
    head,
    base: base ?? null,
    scope: "full",
    files: [],
    reusedRun: null,
  };
  try {
    commit(root, head);
    plan.tree = tree(root, head);
    if (git(root, "rev-parse", "HEAD") !== head)
      throw new Error("Checkout does not match event head");
    if (eventName === "pull_request") {
      if (head !== event.pull_request?.head?.sha)
        throw new Error("Checkout is not the exact PR head");
    } else if (eventName !== "push" || event.ref !== "refs/heads/main" || event.after !== head) {
      throw new Error("Unsupported event or branch");
    }
    Object.assign(plan, changeScope(root, base, head));
    plan.reason = "Changed paths and committed contents determine the checks";
    if (eventName === "push") {
      try {
        plan.reusedRun = await reusableRun(root, head, repository, api);
        if (plan.reusedRun) {
          plan.scope = "reuse";
          plan.reason =
            "Identical Git tree already passed the same-repository PR workflow; no tests rerun";
        }
      } catch {
        plan.reuseUnavailable = "PR workflow or Git tree evidence could not be verified";
      }
    }
  } catch (error) {
    plan.scope = "full";
    plan.reason = error.message;
  }
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let event = {};
  try {
    event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    /* Missing event selects full checks. */
  }
  const api = async (endpoint) =>
    JSON.parse(
      execFileSync("gh", ["api", endpoint], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }),
    );
  const plan = await ciPlan(
    process.cwd(),
    process.env.GITHUB_EVENT_NAME,
    event,
    process.env.CI_HEAD_SHA,
    process.env.GITHUB_REPOSITORY,
    api,
  );
  plan.currentRun = process.env.GITHUB_RUN_ID
    ? {
        id: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      }
    : null;
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  await mkdir("artifacts/ci", { recursive: true });
  await writeFile("artifacts/ci/plan.json", json);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `scope=${plan.scope}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## CI verification scope\n\n\`\`\`json\n${json}\`\`\`\n`,
    );
  process.stdout.write(json);
}
