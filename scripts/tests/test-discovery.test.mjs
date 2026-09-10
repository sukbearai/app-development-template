import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTests, inspectTestLayout } from "../test-discovery.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const runner = path.join(root, "scripts/run-tests.mjs");

async function fixture(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), "pstack test discovery "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir");
  return workspace;
}

async function put(workspace, file, content = "") {
  const target = path.join(workspace, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function run(workspace, ...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}

test("discovery sorts nested tests and preserves independent suites and support files", async (t) => {
  const workspace = await fixture(t);
  await put(workspace, "tests/unit/z.test.mjs");
  await put(workspace, "tests/unit/nested/a space.test.mjs");
  await put(workspace, "tests/integration/database.test.mjs");
  await put(workspace, "tests/web-runtime/routes.test.mjs");
  await put(workspace, "tests/fixtures/child.mjs");
  await put(workspace, "tests/types.ts");
  await put(workspace, "tests/tracing-collector.mjs");
  assert.deepEqual(await discoverTests(workspace, "unit"), [
    "tests/unit/nested/a space.test.mjs",
    "tests/unit/z.test.mjs",
  ]);
  assert.deepEqual(await discoverTests(workspace, "integration"), [
    "tests/integration/database.test.mjs",
  ]);
  assert.deepEqual((await inspectTestLayout(workspace)).findings, []);
  const listed = run(workspace, "integration", "web-runtime", "--list");
  assert.equal(listed.status, 0, listed.stderr);
  const plans = JSON.parse(listed.stdout);
  assert.deepEqual(
    plans.map(({ suite }) => suite),
    ["integration", "web-runtime"],
  );
  assert.equal(plans[0].tsconfig, null);
  assert.equal(plans[1].tsconfig, "../../apps/web/tsconfig.json");
  assert.match(plans[0].loader, /tsx/);
  assert.deepEqual(plans[1].files, ["tests/web-runtime/routes.test.mjs"]);
});

test("misplaced tests and unsupported extensions fail discovery before execution", async (t) => {
  for (const file of [
    "tests/missed.test.mjs",
    "tests/fixtures/hidden.test.mjs",
    "tests/unit/wrong.test.ts",
    "tests/unit/wrong.test.cjs",
  ]) {
    await t.test(file, async (t) => {
      const workspace = await fixture(t);
      await put(workspace, "tests/unit/pass.test.mjs");
      await put(workspace, file);
      await assert.rejects(discoverTests(workspace, "unit"), {
        message: new RegExp(file.replaceAll(".", "\\.")),
      });
      const result = run(workspace, "unit", "--list");
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(file), result.stderr);
    });
  }
});

test("empty declared suites fail even when the entire tests directory is absent", async (t) => {
  const workspace = await fixture(t);
  assert.deepEqual((await inspectTestLayout(workspace)).findings, []);
  assert.equal((await inspectTestLayout(workspace, ["unit"])).findings[0].rule, "test-empty");
  await assert.rejects(discoverTests(workspace, "unit"), /has no tests/);
  await put(workspace, "tests/unit/pass.test.mjs");
  await assert.rejects(discoverTests(workspace, "integration"), /has no tests/);
  assert.equal(run(workspace, "missing").status, 1);
  assert.equal(run(workspace, "unit", "unit").status, 1);
});

test("symbolic links cannot give one test multiple suite owners", async (t) => {
  const workspace = await fixture(t);
  await put(workspace, "tests/unit/pass.test.mjs");
  await symlink(
    path.join(workspace, "tests/unit"),
    path.join(workspace, "tests/integration"),
    "dir",
  );
  await assert.rejects(discoverTests(workspace, "unit"), /test-symlink/);
});

test("a linked tests root cannot bypass layout inspection", async (t) => {
  const workspace = await fixture(t);
  await put(workspace, "elsewhere/unit/pass.test.mjs");
  await symlink(path.join(workspace, "elsewhere"), path.join(workspace, "tests"), "dir");
  await assert.rejects(discoverTests(workspace, "unit"), /test-symlink/);
});

test("web-runtime uses Web tsconfig to resolve actual test imports", async (t) => {
  const repository = await fixture(t);
  const workspace = path.join(repository, "packages/server");
  await put(repository, "packages/server/package.json", '{"type":"module"}');
  await put(
    repository,
    "apps/web/tsconfig.json",
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "web-setting": ["./setting.mjs"] } },
    }),
  );
  await put(repository, "apps/web/setting.mjs", "export const setting = 42;");
  await put(
    workspace,
    "tests/web-runtime/alias.test.mjs",
    'import assert from "node:assert/strict"; import { setting } from "web-setting"; assert.equal(setting, 42);',
  );
  const result = run(workspace, "web-runtime");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("worker --list preserves the dedicated runner without starting containers", async () => {
  const result = spawnSync(process.execPath, ["scripts/test-integration.mjs", "--list"], {
    cwd: path.join(root, "services/worker"),
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [plan] = JSON.parse(result.stdout);
  assert.equal(plan.suite, "integration");
  assert.deepEqual(
    plan.files,
    await discoverTests(path.join(root, "services/worker"), "integration"),
  );
});

test("new nested assertions execute without editing the command and propagate failure", async (t) => {
  const workspace = await fixture(t);
  const file = "tests/unit/new business/failure.test.mjs";
  await put(workspace, file, 'import assert from "node:assert/strict"; assert.equal(1, 2);');
  const red = run(workspace, "unit");
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stdout + red.stderr, /AssertionError/);
  await put(workspace, file, 'import assert from "node:assert/strict"; assert.equal(2, 2);');
  const green = run(workspace, "unit");
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /pass 1/);
});

test("a failed suite prevents a later suite from running", async (t) => {
  const workspace = await fixture(t);
  await put(workspace, "tests/unit/fail.test.mjs", 'throw new Error("first suite fails");');
  await put(
    workspace,
    "tests/integration/later.test.mjs",
    'process.stdout.write("later suite ran");',
  );
  const result = run(workspace, "unit", "integration");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /first suite fails/);
  assert.doesNotMatch(result.stdout + result.stderr, /later suite ran/);
});
