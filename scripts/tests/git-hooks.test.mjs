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
    "scripts/check-dependencies.mjs",
    "scripts/check-conventions.mjs",
    "scripts/convention-policy.mjs",
    "scripts/source-analysis.mjs",
    "scripts/test-discovery.mjs",
    "scripts/source-scope.mjs",
    "scripts/source-scope.json",
  ]) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await cp(path.join(root, file), path.join(cwd, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(manifest));
  const config = JSON.parse(await readFile(path.join(root, ".jscpd.json"), "utf8"));
  await writeFile(path.join(cwd, ".jscpd.json"), JSON.stringify(config));
  await writeFile(path.join(cwd, ".jscpd-baseline.json"), '{"version":1,"fingerprints":{}}\n');
  await mkdir(path.join(cwd, "packages/server/src/modules/reports"), { recursive: true });
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/label.ts"), good);
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/summary.ts"), sample);
  for (const directory of ["apps/web/app", "apps/web/components/ui", "apps/web/lib"])
    await mkdir(path.join(cwd, directory), { recursive: true });
  for (const file of [
    "apps/web/app/page.tsx",
    "apps/web/components/ui/button.tsx",
    "apps/web/lib/client.ts",
  ])
    await writeFile(path.join(cwd, file), good);
  await writeFile(
    path.join(cwd, "apps/web/package.json"),
    JSON.stringify({ name: "@pstack/web", type: "module" }),
  );
  for (const name of ["contracts", "database", "kafka", "server", "sdk", "worker"]) {
    const directory = `${name === "worker" ? "services" : "packages"}/${name}`;
    await mkdir(path.join(cwd, directory, "src"), { recursive: true });
    await writeFile(path.join(cwd, directory, "src/index.ts"), good);
    await writeFile(
      path.join(cwd, directory, "package.json"),
      JSON.stringify({
        name: `@pstack/${name}`,
        type: "module",
        exports: "./src/index.ts",
      }),
    );
    await writeFile(
      path.join(cwd, directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      }),
    );
  }
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
  const directSnapshot = direct.output.match(/checking the staged snapshot at (.+)/)?.[1];
  if (directSnapshot) await assert.rejects(readdir(directSnapshot), { code: "ENOENT" });
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
  const file = path.join(cwd, "packages/server/src/modules/reports/label.ts");
  await writeFile(file, bad);
  git(cwd, "add", "packages/server/src/modules/reports/label.ts");
  await writeFile(file, good);
  await unchangedAfterFailure(cwd, /no-chained-type-assertions/);
  git(cwd, "add", "packages/server/src/modules/reports/label.ts");
  await writeFile(file, bad);
  const success = execute(cwd, "git", ["commit", "-m", "first staged commit"]);
  assert.equal(success.status, 0, success.output);
  assert.equal(git(cwd, "show", "HEAD:packages/server/src/modules/reports/label.ts"), good.trim());
  assert.equal(await readFile(file, "utf8"), bad);
  await assert.rejects(readdir(success.output.match(/checking the staged snapshot at (.+)/)[1]), {
    code: "ENOENT",
  });
  await writeFile(file, good);
  await writeFile(
    path.join(cwd, "packages/server/src/modules/reports/remove-target.ts"),
    good.replace("label", "other"),
  );
  git(cwd, "add", "packages/server/src/modules/reports/remove-target.ts");
  git(cwd, "commit", "-m", "add deletion target");
  git(cwd, "rm", "packages/server/src/modules/reports/remove-target.ts");
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/remove-target.ts"), bad);
  git(cwd, "commit", "-m", "delete staged file");
  assert.equal(git(cwd, "ls-files", "packages/server/src/modules/reports/remove-target.ts"), "");
});

test("real duplicate blocks commit and preserves report paths after cleanup", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/duplicate.ts"), sample);
  git(cwd, "add", "packages/server/src");
  const result = await unchangedAfterFailure(cwd, /new clones|new clones found/i);
  const reportFile = result.output.match(/staged report saved to (.+); line numbers/)[1];
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.ok(report.statistics.total.newClones > 0);
  for (const clone of report.duplicates) {
    assert.ok(
      clone.firstFile.name.endsWith("/src/modules/reports/duplicate.ts") ||
        clone.firstFile.name.endsWith("/src/modules/reports/summary.ts"),
    );
    assert.ok(clone.secondFile.name.startsWith(git(cwd, "rev-parse", "--show-toplevel")));
  }
});

test("gate commands come from the index and run installed tools without dependency installation", async (t) => {
  const cwd = await fixture(t);
  const file = path.join(cwd, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.scripts.lint = `node -e "console.log('STAGED_GATE')" && ${manifest.scripts.lint}`;
  await writeFile(file, JSON.stringify(manifest));
  git(cwd, "add", "package.json");
  manifest.scripts.lint = 'node -e "process.exit(77)"';
  const unstaged = JSON.stringify(manifest);
  await writeFile(file, unstaged);
  const index = await readFile(path.join(cwd, ".git/index"));
  const result = execute(cwd, process.execPath, ["scripts/pre-commit.mjs"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /STAGED_GATE/);
  assert.match(result.output, /Dependencies verified/);
  assert.match(result.output, /Source and test conventions verified/);
  assert.doesNotMatch(result.output, /pnpm install|Verifying lockfile|Ignored build scripts/);
  assert.deepEqual(await readFile(path.join(cwd, ".git/index")), index);
  assert.equal(await readFile(file, "utf8"), unstaged);
});

test("missing staged gate scripts fail instead of skipping checks", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const file = path.join(cwd, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  delete manifest.scripts.lint;
  await writeFile(file, JSON.stringify(manifest));
  git(cwd, "add", "package.json");
  await unchangedAfterFailure(cwd, /Required staged script missing: lint/);
});

test("report preservation handles missing, malformed and unwritable reports independently", async (t) => {
  const dependencyBytes = '{\r\n  "circulars": [], "label": "依赖"\r\n}\r\n';
  for (const scenario of [
    { name: "missing reports after an early gate failure", missing: true },
    { name: "malformed dependency report", malformed: "dependency-report.json" },
    { name: "empty duplication report", malformed: "jscpd-report.json" },
    { name: "unwritable dependency report", blocked: "dependency-report.json" },
    { name: "unwritable duplication report", blocked: "jscpd-report.json" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const cwd = await fixture(t);
      assert.equal(install(cwd).status, 0);
      const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
      for (const command of ["lint", "duplication:check", "dependency:check"])
        manifest.scripts[command] = `node scripts/report-fixture.mjs ${command}`;
      await writeFile(path.join(cwd, "package.json"), JSON.stringify(manifest));
      await writeFile(
        path.join(cwd, "scripts/report-fixture.mjs"),
        `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const scenario = ${JSON.stringify(scenario)};
console.log("GATE " + process.argv[2]);
if (scenario.missing) process.exit(1);
if (process.argv[2] !== "lint") process.exit(0);
for (const [filename, source, contents] of [
  ["dependency-report.json", "dependencies/report.json", ${JSON.stringify(dependencyBytes)}],
  ["jscpd-report.json", "duplication/jscpd-report.json", JSON.stringify({ duplicates: [{
    firstFile: { name: path.join(process.cwd(), "packages/server/src/modules/reports/summary.ts"), start: 1 },
    secondFile: { name: path.join(process.cwd(), "packages/server/src/modules/reports/label.ts"), start: 2 }
  }] })]
]) {
  const file = path.join("artifacts/quality", source);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, scenario.malformed === filename
    ? filename === "jscpd-report.json" ? "" : "{invalid json" : contents);
}
if (scenario.blocked) await mkdir(path.join(${JSON.stringify(cwd)},
  "artifacts/quality/pre-commit", path.basename(process.cwd()), scenario.blocked),
  { recursive: true });
`,
      );
      git(cwd, "add", "package.json", "scripts/report-fixture.mjs");
      const result = await unchangedAfterFailure(
        cwd,
        scenario.missing ? /lint failed/ : /cannot preserve quality report/,
      );
      const commands = [...result.output.matchAll(/^GATE (.+)$/gm)].map((match) => match[1]);
      assert.deepEqual(
        commands,
        scenario.missing ? ["lint"] : ["lint", "duplication:check", "dependency:check"],
      );
      if (scenario.missing) {
        assert.doesNotMatch(result.output, /cannot preserve quality report|report saved/);
        return;
      }
      const failed = scenario.malformed ?? scenario.blocked;
      assert.doesNotMatch(
        result.output,
        new RegExp(`saved to .+/${failed.replaceAll(".", "\\.")}`),
      );
      if (failed === "jscpd-report.json") {
        const saved = result.output.match(/staged dependency report saved to (.+)/)?.[1];
        assert.ok(saved, result.output);
        assert.deepEqual(await readFile(saved), Buffer.from(dependencyBytes));
      } else {
        const saved = result.output.match(/staged report saved to (.+); line numbers/)?.[1];
        assert.ok(saved, result.output);
        const report = JSON.parse(await readFile(saved, "utf8"));
        assert.deepEqual(report.duplicates, [
          {
            firstFile: {
              name: path.join(
                git(cwd, "rev-parse", "--show-toplevel"),
                "packages/server/src/modules/reports/summary.ts",
              ),
              start: 1,
            },
            secondFile: {
              name: path.join(
                git(cwd, "rev-parse", "--show-toplevel"),
                "packages/server/src/modules/reports/label.ts",
              ),
              start: 2,
            },
          },
        ]);
      }
    });
  }
});

test("dependency cycles use staged workspace packages and block the real commit", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  for (const [issuer, target] of [
    ["server", "contracts"],
    ["contracts", "server"],
  ]) {
    const modules = path.join(cwd, `packages/${issuer}/node_modules/@pstack`);
    await mkdir(modules, { recursive: true });
    await symlink(path.join(cwd, `packages/${target}`), path.join(modules, target), "junction");
  }
  const server = "packages/server/src/index.ts";
  const contracts = "packages/contracts/src/index.ts";
  await writeFile(path.join(cwd, server), 'import "@pstack/contracts";\n');
  await writeFile(path.join(cwd, contracts), 'import "@pstack/server";\n');
  git(cwd, "add", "packages");
  await writeFile(path.join(cwd, contracts), good);
  const failure = await unchangedAfterFailure(cwd, /Runtime cycle:/);
  const reportFile = failure.output.match(/staged dependency report saved to (.+)/)?.[1];
  assert.ok(reportFile, failure.output);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.circulars.length, 1);
  assert.ok(report.circulars[0].includes(server));
  assert.ok(report.circulars[0].includes(contracts));
  git(cwd, "add", contracts);
  await writeFile(path.join(cwd, contracts), 'import "@pstack/server";\n');
  const success = execute(cwd, "git", ["commit", "-m", "acyclic staged packages"]);
  assert.equal(success.status, 0, success.output);
  assert.match(success.output, /Dependencies verified/);
  assert.equal(git(cwd, "show", `HEAD:${contracts}`), good.trim());
  assert.equal(await readFile(path.join(cwd, contracts), "utf8"), 'import "@pstack/server";\n');
  await writeFile(path.join(cwd, contracts), good);
  await writeFile(path.join(cwd, server), 'import "@pstack/sdk";\n');
  git(cwd, "add", "packages");
  await unchangedAfterFailure(cwd, /Missing dependency:.*@pstack\/sdk/);
  await writeFile(path.join(cwd, server), 'import "@pstack/contracts";\n');
  await writeFile(
    path.join(cwd, "packages/contracts/package.json"),
    JSON.stringify({
      name: "@pstack/renamed-contracts",
      type: "module",
      exports: "./src/index.ts",
    }),
  );
  git(cwd, "add", "packages");
  await unchangedAfterFailure(cwd, /Missing dependency:.*@pstack\/contracts/);
});

test("missing dependencies and unstaged gate configuration fail clearly", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  await rm(path.join(cwd, "node_modules"));
  await unchangedAfterFailure(cwd, /Missing node_modules/);
  await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "junction");
  for (const file of [
    ".oxlintrc.json",
    "scripts/source-scope.mjs",
    "scripts/source-scope.json",
    "scripts/check-conventions.mjs",
    "scripts/convention-policy.mjs",
    "scripts/source-analysis.mjs",
    "scripts/test-discovery.mjs",
  ]) {
    git(cwd, "rm", "--cached", file);
    const result = await unchangedAfterFailure(cwd, /Required staged file missing:/);
    assert.ok(result.output.includes(`Required staged file missing: ${file}.`));
    git(cwd, "add", file);
  }
});

test("alternate Git index is exported without changing the ordinary index", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const index = await readFile(path.join(cwd, ".git/index"));
  const alternate = path.join(cwd, ".git/alternate-index");
  await writeFile(alternate, index);
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/label.ts"), bad);
  const selected = {
    GIT_INDEX_FILE: alternate,
    GIT_DIR: path.join(cwd, ".git"),
    GIT_WORK_TREE: cwd,
  };
  assert.equal(
    execute(cwd, "git", ["add", "packages/server/src/modules/reports/label.ts"], selected).status,
    0,
  );
  const staged = await readFile(alternate);
  await writeFile(path.join(cwd, "packages/server/src/modules/reports/label.ts"), good);
  const result = execute(cwd, process.execPath, ["scripts/pre-commit.mjs"], selected);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /no-chained-type-assertions/);
  assert.deepEqual(await readFile(alternate), staged);
  assert.deepEqual(await readFile(path.join(cwd, ".git/index")), index);
  assert.equal(
    await readFile(path.join(cwd, "packages/server/src/modules/reports/label.ts"), "utf8"),
    good,
  );
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

test("staged production paths containing spaces fail conventions without changing either tree", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const file = "packages/server/src/modules/reports/with spaces.ts";
  await writeFile(path.join(cwd, file), good);
  git(cwd, "add", file);
  await rm(path.join(cwd, file));
  const result = await unchangedAfterFailure(
    cwd,
    /\[file-name\].*Use kebab-case for with spaces\.ts/,
  );
  assert.match(result.output, /conventions:check failed/);
  assert.equal(git(cwd, "show", `:${file}`), good.trim());
  await assert.rejects(readFile(path.join(cwd, file)), { code: "ENOENT" });
});

test("unstaged source and checker edits cannot hide a staged convention violation", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const file = "packages/server/src/modules/reports/label.ts";
  const violation = "export default function label() { return 42; }\n";
  await writeFile(path.join(cwd, file), violation);
  git(cwd, "add", file);
  await writeFile(path.join(cwd, file), good);
  const checker = path.join(cwd, "scripts/check-conventions.mjs");
  const stagedChecker = await readFile(checker, "utf8");
  await writeFile(checker, 'throw new Error("UNSTAGED_CHECKER_EXECUTED");\n');
  const result = await unchangedAfterFailure(cwd, /\[named-export\]/);
  assert.doesNotMatch(result.output, /UNSTAGED_CHECKER_EXECUTED/);
  assert.equal(git(cwd, "show", `:${file}`), violation.trim());
  assert.equal(await readFile(path.join(cwd, file), "utf8"), good);
  assert.equal(git(cwd, "show", ":scripts/check-conventions.mjs"), stagedChecker.trim());
  await writeFile(checker, stagedChecker);
  git(cwd, "add", file);
  const success = execute(cwd, "git", ["commit", "-m", "fix staged convention"]);
  assert.equal(success.status, 0, success.output);
  assert.match(success.output, /Source and test conventions verified/);
});

test("a missing staged conventions command fails despite an unstaged restored script", async (t) => {
  const cwd = await fixture(t);
  assert.equal(install(cwd).status, 0);
  const file = path.join(cwd, "package.json");
  const original = await readFile(file, "utf8");
  const manifest = JSON.parse(original);
  delete manifest.scripts["conventions:check"];
  await writeFile(file, JSON.stringify(manifest));
  git(cwd, "add", "package.json");
  await writeFile(file, original);
  await unchangedAfterFailure(cwd, /Required staged script missing: conventions:check/);
});
