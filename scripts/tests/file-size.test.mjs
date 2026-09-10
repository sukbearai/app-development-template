import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const oxlint = path.join(root, "node_modules/oxlint/bin/oxlint");

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pstack-file-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(path.join(root, ".oxlintrc.json"), "utf8"));
  for (const plugin of config.jsPlugins) plugin.specifier = path.resolve(root, plugin.specifier);
  await writeFile(path.join(directory, ".oxlintrc.json"), JSON.stringify(config));
  return directory;
}

function code(lines) {
  return (
    Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join(
      "\n",
    ) + "\n"
  );
}

async function lint(directory, file, source) {
  const target = path.join(directory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source);
  const result = spawnSync(
    process.execPath,
    [oxlint, "--config", ".oxlintrc.json", "--disable-nested-config", "--format", "json", file],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout);
  return { status: result.status, diagnostics: report.diagnostics };
}

test("production files allow 600 code lines but reject 601 across every source layout", async (t) => {
  const directory = await fixture(t);
  for (const file of [
    "apps/web/app/page.tsx",
    "apps/web/components/identity/form.tsx",
    "apps/web/lib/client.ts",
    "apps/another/src/entry.ts",
    "packages/server/src/modules/identity/service.ts",
    "packages/sdk/src/index.ts",
    "services/worker/src/async-task.ts",
  ]) {
    const allowed = await lint(directory, file, code(600));
    assert.equal(allowed.status, 0, JSON.stringify(allowed));
    const rejected = await lint(directory, file, code(601));
    assert.equal(rejected.status, 1, JSON.stringify(rejected));
    assert.ok(
      rejected.diagnostics.some(
        (entry) => entry.code === "eslint(max-lines)" && entry.severity === "error",
      ),
    );
  }
});

test("blank and comment-only lines do not consume the production size budget", async (t) => {
  const directory = await fixture(t);
  const source = code(600) + "\n// documentation\n".repeat(350) + "/*\nexplanation\n*/\n";
  const result = await lint(directory, "packages/server/src/example.ts", source);
  assert.equal(result.status, 0, JSON.stringify(result));
});

test("tests and tooling retain lint while generated declarations avoid the file size limit", async (t) => {
  const directory = await fixture(t);
  for (const file of [
    "packages/server/tests/unit/large.test.mjs",
    "apps/web/stories/identity/form.stories.tsx",
    "scripts/maintenance.mjs",
    "packages/sdk/src/schema.d.ts",
  ]) {
    const source = file.endsWith(".d.ts")
      ? Array.from(
          { length: 601 },
          (_, index) => `export declare const value${index}: number;`,
        ).join("\n") + "\n"
      : code(601);
    const result = await lint(directory, file, source);
    assert.equal(result.status, 0, JSON.stringify(result));
    if (file.endsWith(".d.ts")) continue;
    const incorrect = await lint(
      directory,
      file,
      code(601) + "export function invalid() { try { return 1; } finally { return 2; } }\n",
    );
    assert.equal(incorrect.status, 1, JSON.stringify(incorrect));
    assert.ok(
      incorrect.diagnostics.some((entry) => entry.code.includes("no-unsafe-finally")),
      JSON.stringify(incorrect),
    );
  }
});
