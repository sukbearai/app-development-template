import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkDuplication, validateReport } from "../check-duplication.mjs";
import { verificationPlan } from "../pr-verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const oxlint = path.join(root, "node_modules/oxlint/bin/oxlint");
const configFile = path.join(root, ".oxlintrc.json");
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
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

function lint(args) {
  const result = spawnSync(process.execPath, [oxlint, "--config", configFile, "--disable-nested-config", "--report-unused-disable-directives-severity", "error", ...args], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  return result;
}

test("all generic vendor rules are errors and quality gates run in both aggregate entry points", async () => {
  const config = await readJson(".oxlintrc.json");
  const loaded = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import plugin from "./tools/anti-slop/src/index.ts"; console.log(JSON.stringify(Object.keys(plugin.rules)))'], { cwd: root, encoding: "utf8" });
  assert.equal(loaded.status, 0, loaded.stderr);
  const names = JSON.parse(loaded.stdout).map((name) => `anti-slop/${name}`).sort();
  assert.equal(names.length, 15);
  assert.deepEqual(Object.keys(config.rules).sort(), names);
  for (const name of names) assert.equal(config.rules[name], "error");
  assert.equal(config.overrides, undefined);
  const manifest = await readJson("package.json");
  assert.equal(manifest.devDependencies.oxlint, "1.78.0");
  assert.equal(manifest.devDependencies["@oxlint/plugins"], "1.78.0");
  assert.equal(manifest.devDependencies.jscpd, "5.1.2");
  for (const gate of ["lint", "duplication:check"]) {
    assert.ok(manifest.scripts.verify.includes(`pnpm ${gate}`));
    assert.ok(verificationPlan([], { full: true }).includes(gate));
    assert.ok(verificationPlan(["scripts/example.mjs"], {}).includes(gate));
  }
});

test("real lint scans owned scripts and rejects chained assertions and unused suppressions", async () => {
  const directory = await mkdtemp(path.join(root, "scripts/quality-fixture-"));
  try {
    const file = path.join(directory, "probe.ts");
    await writeFile(file, "export const label = 42;\n");
    assert.equal(lint([file]).status, 0);
    const files = lint(["--debug", "files", "."]);
    assert.equal(files.status, 0, files.stderr);
    assert.ok(files.stdout.includes("probe.ts"));
    assert.ok(files.stdout.includes("scripts/check-duplication.mjs"));
    assert.ok(files.stdout.includes(".agents/skills/verify-pstack-x/scripts/app.spec.mjs"));
    assert.ok(files.stdout.includes("scripts/tests/quality-gates.test.mjs"));
    assert.ok(files.stdout.includes("apps/web/app/"));
    assert.ok(!files.stdout.includes("tools/anti-slop/src/"));
    await writeFile(file, "export const label = 42 as unknown as string;\n");
    const invalid = lint([file]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stdout, /no-chained-type-assertions/);
    await writeFile(file, "// oxlint-disable-next-line anti-slop/no-chained-type-assertions\nexport const label = 42;\n");
    const unused = lint([file]);
    assert.equal(unused.status, 1);
    assert.match(unused.stdout, /unused|Unused/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("duplication configuration covers every current production package", async () => {
  const config = await readJson(".jscpd.json");
  const packages = (await readdir(path.join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}/src`);
  assert.deepEqual([...config.path].sort(), ["apps/web/app", "apps/web/components", "apps/web/lib", "services/worker/src", ...packages].sort());
  assert.equal(config.minLines, 8);
  assert.equal(config.minTokens, 80);
  assert.equal(config.mode, "weak");
  assert.equal(config.crossFormats, "js-ts");
  assert.equal(config.absolute, true);
  assert.equal(config.baseline, undefined);
  assert.equal(config.updateBaseline, undefined);
  assert.equal(config.failOnNewClones, undefined);
});

test("native baseline accepts existing clones, rejects new copies, and fails on missing or empty inputs", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-quality-"));
  try {
    const config = await readJson(".jscpd.json");
    config.path = ["src"];
    await writeFile(path.join(cwd, ".jscpd.json"), JSON.stringify(config));
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src/a.ts"), sample);
    const baselineFile = path.join(cwd, ".jscpd-baseline.json");
    await assert.rejects(checkDuplication({ cwd }), /ENOENT/);
    await writeFile(baselineFile, '{"version":1,"fingerprints":{}}\n');
    assert.equal((await checkDuplication({ cwd })).newClones, 0);
    const baseline = await readFile(baselineFile, "utf8");
    await writeFile(path.join(cwd, "src/b.ts"), sample);
    await assert.rejects(checkDuplication({ cwd }), /new clones/);
    assert.equal(await readFile(baselineFile, "utf8"), baseline);
    const accepted = spawnSync(process.execPath, [path.join(root, "node_modules/jscpd/run-jscpd.js"), "--config", ".jscpd.json", "--baseline", baselineFile, "--update-baseline"], { cwd, encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal((await checkDuplication({ cwd })).newClones, 0);
    await writeFile(path.join(cwd, "src/c.ts"), sample);
    await assert.rejects(checkDuplication({ cwd }), /new clones/);
    await rm(path.join(cwd, "src/c.ts"));
    await writeFile(baselineFile, "not json");
    await assert.rejects(checkDuplication({ cwd }));
    await writeFile(baselineFile, baseline);
    await rm(path.join(cwd, "src/a.ts"));
    await rm(path.join(cwd, "src/b.ts"));
    await assert.rejects(checkDuplication({ cwd }), /no source|ENOENT/);
    await rm(path.join(cwd, "src"), { recursive: true });
    await assert.rejects(checkDuplication({ cwd }), /ENOENT/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("missing, malformed and inconsistent reports fail validation", () => {
  for (const report of [null, {}, { statistics: { total: { sources: 0 } } }, { statistics: { total: { sources: 1, tokens: 1, clones: 0, newClones: 0 } } }, { statistics: { total: { sources: 1, tokens: 1, clones: 1, newClones: 0 } }, duplicates: [] }]) {
    assert.throws(() => validateReport(report));
  }
});

test("CI refuses the explicit baseline update command", () => {
  const result = spawnSync(process.execPath, ["scripts/check-duplication.mjs", "--update-baseline"], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disabled in CI/);
});
