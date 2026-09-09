import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
const good = "export const label = 42;\n";
const bad = "export const label = 42 as unknown as string;\n";

const sample = `export function summarize(values: number[]) {
  const accepted = values.filter(value => value > 10);
  const count = accepted.length;
  const total = accepted.reduce((sum, value) => sum + value, 0);
  const average = count > 0 ? total / count : 0;
  const minimum = Math.min(...accepted);
  const maximum = Math.max(...accepted);
  const first = accepted.at(0);
  const last = accepted.at(-1);
  const spread = maximum - minimum;
  const doubled = accepted.map(value => value * 2);
  return { count, total, average, minimum, maximum, first, last, spread, doubled };
}
`;

function execute(cwd, executable, args, overrides = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

function git(cwd, ...args) {
  const result = execute(cwd, "git", args);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim();
}

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-hooks-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init");
  git(cwd, "config", "user.email", "hooks@example.invalid");
  git(cwd, "config", "user.name", "Hook tests");
  git(cwd, "config", "commit.gpgsign", "false");
  for (const file of [
    ".githooks",
    ".gitattributes",
    ".gitignore",
    ".oxlintrc.json",
    "tools/anti-slop",
    "scripts/pre-commit.mjs",
    "scripts/install-hooks.mjs",
    "scripts/check-duplication.mjs",
  ]) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await cp(path.join(root, file), path.join(cwd, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(manifest));
  const config = JSON.parse(await readFile(path.join(root, ".jscpd.json"), "utf8"));
  config.path = ["src"];
  await writeFile(path.join(cwd, ".jscpd.json"), JSON.stringify(config));
  await writeFile(path.join(cwd, ".jscpd-baseline.json"), '{"version":1,"fingerprints":{}}\n');
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src/with spaces.ts"), good);
  await writeFile(path.join(cwd, "src/summary.ts"), sample);
  await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "junction");
  git(cwd, "add", ".");
  return cwd;
}

function install(cwd) {
  return execute(cwd, process.execPath, ["scripts/install-hooks.mjs"]);
}

async function unchangedAfterFailure(cwd, expected) {
  const before = git(cwd, "diff", "--binary");
  const entries = git(cwd, "ls-files", "--stage");
  const index = await readFile(path.join(cwd, ".git/index"));
  const direct = execute(cwd, process.execPath, ["scripts/pre-commit.mjs"]);
  assert.notEqual(direct.status, 0, direct.output);
  assert.match(direct.output, expected);
  assert.ok(
    (await readFile(path.join(cwd, ".git/index"))).equals(index),
    "hook changed index bytes",
  );
  const result = execute(cwd, "git", ["commit", "-m", "must fail"]);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, expected);
  assert.equal(git(cwd, "ls-files", "--stage"), entries);
  assert.equal(git(cwd, "diff", "--binary"), before);
  const snapshot = result.output.match(/checking the staged snapshot at (.+)/)?.[1];
  if (snapshot) await assert.rejects(readdir(snapshot), { code: "ENOENT" });
  return result;
}

test("installer refuses foreign configuration and default hooks, and is idempotent", async (t) => {
  const cwd = await fixture(t);
  git(cwd, "config", "core.hooksPath", "foreign-hooks");
  assert.match(install(cwd).output, /Existing core.hooksPath/);
  assert.equal(git(cwd, "config", "core.hooksPath"), "foreign-hooks");
  git(cwd, "config", "--unset", "core.hooksPath");
  for (const name of ["pre-commit", "pre-push"]) {
    const foreign = path.join(cwd, ".git/hooks", name);
    await writeFile(foreign, "#!/bin/sh\nexit 0\n");
    assert.match(install(cwd).output, /Existing hooks at/);
    assert.equal(await readFile(foreign, "utf8"), "#!/bin/sh\nexit 0\n");
    await rm(foreign);
  }
  assert.equal(install(cwd).status, 0);
  assert.equal(install(cwd).status, 0);
  assert.equal(git(cwd, "config", "--local", "core.hooksPath"), ".githooks");
});

test("real first commit, partial staging and deletions validate the index and clean temporary files", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const file = path.join(cwd, "src/with spaces.ts");
  await writeFile(file, bad);
  git(cwd, "add", "src/with spaces.ts");
  await writeFile(file, good);
  await unchangedAfterFailure(cwd, /no-chained-type-assertions/);
  git(cwd, "add", "src/with spaces.ts");
  await writeFile(file, bad);
  const success = execute(cwd, "git", ["commit", "-m", "first staged commit"]);
  assert.equal(success.status, 0, success.output);
  assert.equal(git(cwd, "show", "HEAD:src/with spaces.ts"), good.trim());
  assert.equal(await readFile(file, "utf8"), bad);
  await assert.rejects(readdir(success.output.match(/checking the staged snapshot at (.+)/)[1]), {
    code: "ENOENT",
  });
  await writeFile(file, good);
  await writeFile(path.join(cwd, "src/remove me.ts"), good.replace("label", "other"));
  git(cwd, "add", "src/remove me.ts");
  git(cwd, "commit", "-m", "add deletion target");
  git(cwd, "rm", "src/remove me.ts");
  await writeFile(path.join(cwd, "src/remove me.ts"), bad);
  git(cwd, "commit", "-m", "delete staged file");
  assert.equal(git(cwd, "ls-files", "src/remove me.ts"), "");
});

test("real duplicate blocks commit and preserves report paths after cleanup", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  await writeFile(path.join(cwd, "src/duplicate.ts"), sample);
  git(cwd, "add", "src");
  const result = await unchangedAfterFailure(cwd, /new clones|new clones found/i);
  const reportFile = result.output.match(/staged report saved to (.+); line numbers/)[1];
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.ok(report.statistics.total.newClones > 0);
  for (const clone of report.duplicates) {
    assert.ok(
      clone.firstFile.name.endsWith("/src/duplicate.ts") ||
        clone.firstFile.name.endsWith("/src/summary.ts"),
    );
    assert.ok(clone.secondFile.name.startsWith(git(cwd, "rev-parse", "--show-toplevel")));
  }
});

test("missing dependencies and unstaged gate configuration fail clearly", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  await rm(path.join(cwd, "node_modules"));
  await unchangedAfterFailure(cwd, /Missing node_modules/);
  await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "junction");
  git(cwd, "rm", "--cached", ".oxlintrc.json");
  await unchangedAfterFailure(cwd, /Required staged file missing: .oxlintrc.json/);
});

test("alternate Git index is exported without changing the ordinary index", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const index = await readFile(path.join(cwd, ".git/index"));
  const alternate = path.join(cwd, ".git/alternate-index");
  await writeFile(alternate, index);
  await writeFile(path.join(cwd, "src/with spaces.ts"), bad);
  const selected = {
    GIT_INDEX_FILE: alternate,
    GIT_DIR: path.join(cwd, ".git"),
    GIT_WORK_TREE: cwd,
  };
  assert.equal(execute(cwd, "git", ["add", "src/with spaces.ts"], selected).status, 0);
  const staged = await readFile(alternate);
  await writeFile(path.join(cwd, "src/with spaces.ts"), good);
  const result = execute(cwd, process.execPath, ["scripts/pre-commit.mjs"], selected);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /no-chained-type-assertions/);
  assert.deepEqual(await readFile(alternate), staged);
  assert.deepEqual(await readFile(path.join(cwd, ".git/index")), index);
  assert.equal(await readFile(path.join(cwd, "src/with spaces.ts"), "utf8"), good);
});

test(
  "termination stops the check process group and removes the snapshot",
  { skip: process.platform === "win32", timeout: 15_000 },
  async (t) => {
    const cwd = await fixture(t);
    const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    manifest.scripts.lint = "node scripts/wait.mjs";
    await writeFile(path.join(cwd, "package.json"), JSON.stringify(manifest));
    await writeFile(
      path.join(cwd, "scripts/wait.mjs"),
      "console.log(`CHECK_READY ${process.pid}`); setInterval(() => {}, 1000);\n",
    );
    git(cwd, "add", "package.json", "scripts/wait.mjs");
    const index = await readFile(path.join(cwd, ".git/index"));
    const child = spawn(process.execPath, ["scripts/pre-commit.mjs"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGTERM"));
    let output = "";
    const finished = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error(output)));
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("CHECK_READY")) resolve();
      });
    });
    child.kill("SIGTERM");
    assert.equal(await finished, 1, output);
    const snapshot = output.match(/checking the staged snapshot at (.+)/)[1];
    await assert.rejects(readdir(snapshot), { code: "ENOENT" });
    const worker = Number(output.match(/CHECK_READY (\d+)/)[1]);
    assert.throws(() => process.kill(worker, 0), { code: "ESRCH" });
    assert.ok((await readFile(path.join(cwd, ".git/index"))).equals(index));
  },
);
