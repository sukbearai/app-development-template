import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDependencies } from "../check-dependencies.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-dependencies-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const write = async (filename, source) => {
    await mkdir(path.dirname(path.join(cwd, filename)), { recursive: true });
    await writeFile(path.join(cwd, filename), source);
  };
  for (const filename of [
    "apps/web/app/page.tsx",
    "apps/web/components/button.tsx",
    "apps/web/lib/client.ts",
    "packages/contracts/src/index.ts",
    "packages/database/src/index.ts",
    "packages/kafka/src/index.ts",
    "packages/server/src/index.ts",
    "packages/sdk/src/index.ts",
    "services/worker/src/index.ts",
    "packages/model/src/index.ts",
    "services/jobs/src/index.ts",
  ])
    await write(filename, "export const value = 1;");
  const manifest = JSON.parse(
    await readFile(path.join(repository, "scripts/source-scope.json"), "utf8"),
  );
  for (const directory of ["packages/model/src", "services/jobs/src"])
    manifest.push({
      path: directory,
      tools: { boundary: true, dependency: true, duplication: true },
    });
  await write("scripts/source-scope.json", JSON.stringify(manifest));
  await copyFile(
    path.join(repository, "scripts/source-scope.mjs"),
    path.join(cwd, "scripts/source-scope.mjs"),
  );
  return {
    manifest,
    cwd,
    write,
    run: () => checkDependencies({ cwd }),
    report: async () =>
      JSON.parse(
        await readFile(path.join(cwd, "artifacts/quality/dependencies/report.json"), "utf8"),
      ),
  };
}

test("dependency gate analyzes disconnected routes, cycles and runtime imports", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).counts.entries, 11);
  const route = "apps/web/app/api/[...segments]/route.ts";
  const sibling = "apps/web/app/api/[...segments]/other.ts";
  await f.write(route, 'import "./other";');
  await f.write(sibling, 'import "./route";');
  await assert.rejects(f.run(), /Runtime cycle:.*\[\.\.\.segments\]/);
  assert.ok((await f.report()).entries.includes(route));
  for (const edge of [
    'export * from "./other";',
    'export const lazy = () => import("./other");',
    'const other = require("./other"); export { other };',
    'import { value, type Shape } from "./other"; export { value };',
  ]) {
    await f.write(route, edge);
    await assert.rejects(f.run(), /Runtime cycle:/);
  }
  await f.write(route, 'import "./route";');
  await assert.rejects(f.run(), /Runtime cycle:/);
  await f.write(route, 'import type { Shape } from "./other"; export type Item = Shape;');
  await f.write(sibling, 'export type { Item } from "./route"; export type Shape = string;');
  assert.deepEqual((await f.run()).circulars, []);
});

test("dependency gate resolves nearest aliases and workspace package source", async (t) => {
  const f = await fixture(t);
  await f.write(
    "apps/web/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
        module: "ESNext",
        paths: { "@/*": ["./*"] },
      },
    }),
  );
  await f.write("apps/web/app/page.tsx", 'export { value } from "@/lib/client";');
  await f.write(
    "packages/model/package.json",
    JSON.stringify({ name: "@fixture/model", exports: "./src/index.ts" }),
  );
  await f.write(
    "services/jobs/tsconfig.json",
    JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", module: "ESNext" } }),
  );
  await mkdir(path.join(f.cwd, "services/jobs/node_modules/@fixture"), { recursive: true });
  await symlink(
    path.join(f.cwd, "packages/model"),
    path.join(f.cwd, "services/jobs/node_modules/@fixture/model"),
  );
  await f.write("services/jobs/src/index.ts", 'export { value } from "@fixture/model";');
  assert.equal((await f.run()).counts.entries, 11);
  await f.write("packages/model/src/index.ts", 'import "../../../services/jobs/src/index";');
  await assert.rejects(f.run(), /Runtime cycle:/);
  await f.write("packages/model/src/index.ts", "export const value = 1;");
  for (const request of ["./absent", "@/lib/absent", "package-that-does-not-exist"]) {
    await f.write("apps/web/app/page.tsx", `import "${request}";`);
    await assert.rejects(f.run(), /Missing dependency: apps\/web\/app\/page.tsx/);
    assert.equal((await f.report()).missing[0].request, request);
  }
});

test("dependency gate rejects empty roots and removes stale evidence on parser failure", async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.write("apps/web/tsconfig.json", "invalid config");
  await f.write("apps/web/app/page.tsx", 'import "node:fs";');
  await assert.rejects(f.run());
  await assert.rejects(f.report(), { code: "ENOENT" });
  await rm(path.join(f.cwd, "apps/web/tsconfig.json"));
  await rm(path.join(f.cwd, "apps/web/lib/client.ts"));
  await assert.rejects(f.run(), /Empty production root: apps\/web\/lib/);
  await f.write("apps/web/lib/client.ts", "export {};");
  await mkdir(path.join(f.cwd, "packages/new-package/src"), { recursive: true });
  await assert.rejects(f.run(), /Unclassified production root: packages\/new-package\/src/);
  await rm(path.join(f.cwd, "packages/new-package"), { recursive: true });
  await rm(path.join(f.cwd, "services/jobs/src"), { recursive: true });
  await assert.rejects(f.run(), /Missing production root: services\/jobs\/src/);
  await rm(path.join(f.cwd, "services"), { recursive: true });
  await mkdir(path.join(f.cwd, "services"));
  await assert.rejects(f.run(), /Missing production root: services\/worker\/src/);
});

test("dependency gate accepts only installed Web vinext shims", async (t) => {
  const f = await fixture(t);
  await f.write("apps/web/app/page.tsx", 'import "next/headers";');
  await assert.rejects(f.run(), /Missing dependency:/);
  await mkdir(path.join(f.cwd, "apps/web/node_modules"), { recursive: true });
  await symlink(
    path.join(repository, "apps/web/node_modules/vinext"),
    path.join(f.cwd, "apps/web/node_modules/vinext"),
  );
  for (const request of ["next/headers", "next/link", "next/navigation"]) {
    await f.write("apps/web/app/page.tsx", `import "${request}";`);
    assert.ok(
      (await f.run()).external.some((edge) => edge.request === request && edge.kind === "vinext"),
    );
  }
  await f.write("apps/web/app/page.tsx", 'import "next/haeders";');
  await assert.rejects(f.run(), /next\/haeders/);
  await f.write("apps/web/app/page.tsx", "export {};");
  await f.write("packages/model/src/index.ts", 'import "next/headers";');
  await assert.rejects(f.run(), /Missing dependency: packages\/model/);
});

test("dependency gate rejects suppression comments, including imported local files", async (t) => {
  const f = await fixture(t);
  await f.write("apps/web/app/page.tsx", 'export const text = "@dpdm-ignore";');
  await f.run();
  await f.write("apps/web/app/page.tsx", '// @dpdm-ignore\nimport "./missing";');
  await assert.rejects(f.run(), /Forbidden @dpdm-ignore comment:/);
  await f.write("apps/web/app/page.tsx", 'import "../../shared";');
  await f.write("apps/shared.ts", '/* @dpdm-ignore */\nimport "./missing";');
  await assert.rejects(f.run(), /Forbidden @dpdm-ignore comment: apps\/shared.ts/);
  await f.write("apps/shared.ts", 'import "./missing";');
  await assert.rejects(f.run(), /Missing dependency: apps\/shared.ts/);
});

test("dependency gate rejects first-party modules hidden behind node_modules symlinks", async (t) => {
  const f = await fixture(t);
  await f.write("shared/index.js", "exports.value = 1;");
  await f.write(
    "apps/web/tsconfig.json",
    JSON.stringify({
      compilerOptions: { moduleResolution: "Bundler", module: "ESNext", preserveSymlinks: true },
    }),
  );
  await mkdir(path.join(f.cwd, "apps/web/node_modules"), { recursive: true });
  await symlink(path.join(f.cwd, "shared"), path.join(f.cwd, "apps/web/node_modules/local-shared"));
  await f.write("apps/web/app/page.tsx", 'import "local-shared";');
  await assert.rejects(f.run(), /Skipped local module:/);
});

test("dependency command rejects options that could bypass checking", async (t) => {
  const f = await fixture(t);
  await copyFile(
    path.join(repository, "scripts/check-dependencies.mjs"),
    path.join(f.cwd, "scripts/check-dependencies.mjs"),
  );
  await symlink(path.join(repository, "node_modules"), path.join(f.cwd, "node_modules"));
  const run = (args) =>
    execFileSync(process.execPath, ["scripts/check-dependencies.mjs", ...args], {
      cwd: f.cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
  assert.match(run([]), /Dependencies verified/);
  assert.throws(() => run(["--skip-dynamic-imports"]), /accepts no arguments/);
});

test("dependency gate rejects unsupported first-party source extensions", async (t) => {
  const f = await fixture(t);
  for (const extension of ["cjs", "cts", "mts"]) {
    const disconnected = `packages/model/src/hidden.${extension}`;
    await f.write(disconnected, `require('./missing.${extension}');`);
    await assert.rejects(f.run(), /Unsupported local source extension:/);
    await rm(path.join(f.cwd, disconnected));
    await f.write(`apps/hidden.${extension}`, `require('./missing.${extension}');`);
    await f.write("apps/web/app/page.tsx", `import '../../hidden.${extension}';`);
    await assert.rejects(f.run(), /Unsupported local source extension: apps\/hidden/);
    assert.ok(!(await f.report()).scannedFiles.includes(`apps/hidden.${extension}`));
    await f.write("apps/web/app/page.tsx", "export {};");
  }
  for (const extension of ["ts", "cts", "mts"])
    await f.write(`packages/model/src/types.d.${extension}`, "export declare const value: number;");
  await f.write("apps/web/app/page.tsx", 'import "./data.json"; import "./style.css";');
  await f.write("apps/web/app/data.json", "{}");
  await f.write("apps/web/app/style.css", "body {}");
  const report = await f.run();
  assert.deepEqual(report.assets, ["apps/web/app/data.json", "apps/web/app/style.css"]);
  assert.equal(report.counts.scannedFiles, 11);
});

test("dependency gate rejects literal dynamic imports that dpdm cannot analyze", async (t) => {
  const f = await fixture(t);
  for (const expression of [
    'import("./missing.js", { with: { type: "json" } })',
    "import(`./missing.js`)",
  ]) {
    await f.write("apps/web/app/page.tsx", `export const load = () => ${expression};`);
    await assert.rejects(f.run(), /Unsupported literal dynamic import signature:.*missing.js/);
  }
  await f.write("apps/web/app/page.tsx", 'import "../../shared";');
  await f.write("apps/shared.ts", 'export const load = () => import("./missing.js", {});');
  await assert.rejects(f.run(), /Unsupported literal dynamic import signature: apps\/shared.ts/);
});

test("dependency gate treats route groups, slots and punctuation as literal paths", async (t) => {
  const f = await fixture(t);
  const routes = ["!leading", "(group)", "@slot", "[parameter]", "[...rest]"];
  for (const route of routes)
    await f.write(
      `apps/web/app/${route}/page.tsx`,
      "export default function Page() { return null; }",
    );
  const report = await f.run();
  for (const route of routes)
    assert.ok(report.scannedFiles.includes(`apps/web/app/${route}/page.tsx`));
});

test("dependency gate requires classification before analyzing new workspace roots", async (t) => {
  const f = await fixture(t);
  for (const directory of ["packages/added/src", "services/added/src", "apps/added/app"]) {
    await f.write(`${directory}/first.ts`, 'import "./second";');
    await f.write(`${directory}/second.ts`, 'import "./first";');
    await assert.rejects(f.run(), /Unclassified production root:/);
    await assert.rejects(f.report(), { code: "ENOENT" });
    f.manifest.push({
      path: directory,
      tools: { boundary: true, dependency: true, duplication: true },
    });
    await f.write("scripts/source-scope.json", JSON.stringify(f.manifest));
    await assert.rejects(f.run(), /Runtime cycle:/);
    assert.ok((await f.report()).entries.includes(`${directory}/first.ts`));
    await f.write(`${directory}/second.ts`, "export {};");
    await f.run();
  }
});
