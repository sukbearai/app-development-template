import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changeScope, ciPlan, reusableRun } from "../ci-plan.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-ci-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI plan test");
  git("config", "commit.gpgsign", "false");
  const pkg = {
    version: "0.1.0",
    scripts: { test: "node test.mjs" },
    dependencies: { lib: "1.0.0" },
  };
  async function save(files) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  }
  const base = await save({
    "package.json": JSON.stringify(pkg),
    ".release-please-manifest.json": '{".":"0.1.0"}',
    "CHANGELOG.md": "# 0.1.0\n",
  });
  return { root, git, pkg, base, save };
}

test("version profile compares package fields and rejects dependency or script changes", async (t) => {
  const f = await fixture(t);
  const version = await f.save({
    "package.json": JSON.stringify({ ...f.pkg, version: "0.2.0" }),
    ".release-please-manifest.json": '{".":"0.2.0"}',
    "CHANGELOG.md": "# 0.2.0\n",
  });
  assert.equal(changeScope(f.root, f.base, version).scope, "version");
  for (const change of [{ dependencies: { lib: "2.0.0" } }, { scripts: { test: "true" } }]) {
    const head = await f.save({
      "package.json": JSON.stringify({ ...f.pkg, version: "0.2.0", ...change }),
    });
    assert.equal(changeScope(f.root, f.base, head).scope, "full");
  }
});

test("manifest additions and invalid version values never select version checks", async (t) => {
  const f = await fixture(t);
  for (const manifest of ['{".":"0.2.0","packages/server":"0.2.0"}', '{".":null}', "invalid"]) {
    const head = await f.save({ ".release-please-manifest.json": manifest });
    const plan = await ciPlan(
      f.root,
      "pull_request",
      { pull_request: { base: { sha: f.base }, head: { sha: head } } },
      head,
      "owner/repo",
    );
    assert.equal(plan.scope, "full");
  }
});

test("engineering whitelist rejects runtime, mixed, unknown and renamed paths", async (t) => {
  const f = await fixture(t);
  const engineering = await f.save({
    "scripts/ci-plan.mjs": "export const value = 1;\n",
    "docs/deployment-execution.md": "Deployment\n",
  });
  assert.equal(changeScope(f.root, f.base, engineering).scope, "engineering");
  for (const file of [
    "apps/web/app/page.tsx",
    "pnpm-lock.yaml",
    "packages/database/migrations/new.sql",
    "docs/new.md",
    " docs/engineering-tools.md",
  ]) {
    f.git("reset", "--hard", engineering);
    const head = await f.save({ [file]: "changed\n" });
    assert.equal(changeScope(f.root, f.base, head).scope, "full", file);
  }
  f.git("reset", "--hard", engineering);
  f.git("mv", "scripts/ci-plan.mjs", "scripts/unknown.mjs");
  f.git("commit", "-m", "rename");
  assert.equal(changeScope(f.root, engineering, f.git("rev-parse", "HEAD")).scope, "full");
});

test("missing bases, diverged bases, synthetic checkouts and unsupported events use full checks", async (t) => {
  const f = await fixture(t);
  const head = await f.save({ "scripts/ci-plan.mjs": "export {};\n" });
  for (const base of [undefined, "0".repeat(40)]) {
    const plan = await ciPlan(
      f.root,
      "pull_request",
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      head,
      "owner/repo",
    );
    assert.equal(plan.scope, "full");
  }
  f.git("checkout", "--detach", f.base);
  const other = await f.save({ "docs/engineering-tools.md": "other\n" });
  f.git("checkout", "--detach", head);
  assert.equal(
    (
      await ciPlan(
        f.root,
        "pull_request",
        { pull_request: { base: { sha: other }, head: { sha: head } } },
        head,
      )
    ).scope,
    "full",
  );
  assert.equal(
    (
      await ciPlan(
        f.root,
        "pull_request",
        { pull_request: { base: { sha: f.base }, head: { sha: f.base } } },
        head,
      )
    ).scope,
    "full",
  );
  assert.equal((await ciPlan(f.root, "workflow_dispatch", {}, head)).scope, "full");
});

async function mergedFixture(t) {
  const f = await fixture(t);
  const prHead = await f.save({ "scripts/ci-plan.mjs": "export {};\n" });
  const head = f.git("commit-tree", `${prHead}^{tree}`, "-p", prHead, "-m", "merge result");
  f.git("reset", "--hard", head);
  const repository = "owner/repo";
  const pull = {
    number: 7,
    merged_at: "2026-09-09T00:00:00Z",
    merge_commit_sha: head,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: prHead, repo: { full_name: repository } },
  };
  const run = {
    id: 42,
    html_url: "https://github.com/owner/repo/actions/runs/42",
    run_attempt: 1,
    name: "Verify template",
    path: ".github/workflows/ci.yml",
    head_sha: prHead,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_repository: { full_name: repository },
    pull_requests: [],
  };
  const api = async (endpoint) =>
    endpoint.includes("/pulls?") ? [pull] : { workflow_runs: [run] };
  return { ...f, head, prHead, repository, pull, run, api };
}

test("main reuses only an identical tree from a successful matching same-repository PR run", async (t) => {
  const f = await mergedFixture(t);
  const event = { before: f.base, after: f.head, ref: "refs/heads/main" };
  const plan = await ciPlan(f.root, "push", event, f.head, f.repository, f.api);
  assert.equal(plan.scope, "reuse");
  assert.equal(plan.reusedRun.id, 42);
  assert.equal(plan.reusedRun.head, f.prHead);
  for (const state of [
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: null },
  ]) {
    const rerunApi = async (endpoint) =>
      endpoint.includes("/pulls?") ? [f.pull] : { workflow_runs: [{ ...f.run, ...state }, f.run] };
    assert.equal(await reusableRun(f.root, f.head, f.repository, rerunApi), null);
  }
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_sha: f.base },
    { event: "push" },
    { path: ".github/workflows/other.yml" },
    { name: "Other workflow" },
    { head_repository: { full_name: "fork/repo" } },
  ]) {
    const badApi = async (endpoint) =>
      endpoint.includes("/pulls?") ? [f.pull] : { workflow_runs: [{ ...f.run, ...patch }] };
    assert.equal(await reusableRun(f.root, f.head, f.repository, badApi), null);
  }
  for (const patch of [
    { merged_at: null },
    { merge_commit_sha: f.base },
    { head: { ...f.pull.head, repo: { full_name: "fork/repo" } } },
  ]) {
    const badApi = async () => [{ ...f.pull, ...patch }];
    assert.equal(await reusableRun(f.root, f.head, f.repository, badApi), null);
  }
  const unavailable = await ciPlan(f.root, "push", event, f.head, f.repository, async () => {
    throw new Error("API unavailable");
  });
  assert.equal(unavailable.scope, "engineering");
  assert.equal(unavailable.reusedRun, null);
  const changed = await f.save({ "apps/web/app/page.tsx": "changed runtime\n" });
  f.pull.merge_commit_sha = changed;
  assert.equal(await reusableRun(f.root, changed, f.repository, f.api), null);
  assert.equal(
    (await ciPlan(f.root, "push", { ...event, after: changed }, changed, f.repository, f.api))
      .scope,
    "full",
  );
});

test("CLI records the exact input commits, scope and workflow output before dependencies", async (t) => {
  const f = await fixture(t);
  const head = await f.save({ "scripts/ci-plan.mjs": "export {};\n" });
  const eventPath = path.join(f.root, ".git", "event.json");
  const output = path.join(f.root, ".git", "output");
  await writeFile(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: f.base }, head: { sha: head } } }),
  );
  const script = path.resolve(import.meta.dirname, "../ci-plan.mjs");
  const stdout = execFileSync(process.execPath, [script], {
    cwd: f.root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      CI_HEAD_SHA: head,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: "",
    },
  });
  const evidence = JSON.parse(await readFile(path.join(f.root, "artifacts/ci/plan.json"), "utf8"));
  assert.deepEqual(JSON.parse(stdout), evidence);
  assert.equal(evidence.head, head);
  assert.equal(evidence.base, f.base);
  assert.equal(evidence.scope, "engineering");
  assert.equal(evidence.reusedRun, null);
  assert.equal(await readFile(output, "utf8"), "scope=engineering\n");
});

test("workflow preserves the required check and gates every application execution on full scope", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /jobs:\n  verify:/);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  const steps = workflow.split(/\n      - /);
  for (const command of [
    "pnpm exec playwright",
    "pnpm db:migrate",
    "pnpm admin:bootstrap",
    "pnpm pr:verify --full",
    "pnpm test:capacity",
    "pnpm test:backup",
    "pnpm test:app-backup",
    "docker compose",
    "pnpm test:containers",
    "pnpm test:cold-start",
  ]) {
    const step = steps.find((entry) => entry.startsWith(`run: ${command}`));
    assert.ok(step, command);
    assert.match(step, /if: steps\.plan\.outputs\.scope == 'full'/);
  }
  assert.match(
    steps.find((step) => step.startsWith("uses: actions/upload-artifact@")),
    /if: always\(\)/,
  );
});

test("missing local PR head uses a matching GitHub commit object and rejects a different tree", async (t) => {
  const f = await mergedFixture(t);
  const remoteHead = "a".repeat(40);
  f.pull.head.sha = remoteHead;
  f.run.head_sha = remoteHead;
  let remoteTree = f.git("rev-parse", `${f.head}^{tree}`);
  const api = async (endpoint) =>
    endpoint.includes("/git/commits/")
      ? { sha: remoteHead, tree: { sha: remoteTree } }
      : f.api(endpoint);
  assert.equal((await reusableRun(f.root, f.head, f.repository, api)).head, remoteHead);
  remoteTree = "b".repeat(40);
  assert.equal(await reusableRun(f.root, f.head, f.repository, api), null);
});

test("source, convention rules and discovery changes retain full verification", async (t) => {
  const f = await fixture(t);
  for (const file of [
    "packages/server/src/modules/projects/service.ts",
    "scripts/check-conventions.mjs",
    "scripts/convention-policy.mjs",
    "scripts/source-analysis.mjs",
    "scripts/test-discovery.mjs",
    "scripts/run-tests.mjs",
    "scripts/tests/conventions.test.mjs",
    "scripts/verification-plan.mjs",
  ]) {
    f.git("reset", "--hard", f.base);
    const head = await f.save({ [file]: "export {};\n" });
    assert.equal(changeScope(f.root, f.base, head).scope, "full", file);
  }
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const engineering = workflow
    .split(/\n      - /)
    .find((step) => step.startsWith("name: Check engineering changes"));
  assert.match(engineering, /if: steps\.plan\.outputs\.scope == 'engineering'/);
  assert.match(engineering, /pnpm conventions:check/);
});
