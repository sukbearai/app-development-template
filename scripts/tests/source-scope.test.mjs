import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sourceRoots } from "../source-scope.mjs";

test("source scope rejects incomplete classifications and unexplained exclusions", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-source-scope-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "scripts"));
  await mkdir(path.join(cwd, "packages/sample/src"), { recursive: true });
  const manifestFile = path.join(cwd, "scripts/source-scope.json");
  const entry = {
    path: "packages/sample/src",
    tools: { boundary: true, dependency: true, duplication: true },
  };
  const save = (manifest) => writeFile(manifestFile, JSON.stringify(manifest));
  await save([entry]);
  assert.deepEqual(await sourceRoots(cwd, "dependency"), ["packages/sample/src"]);
  await assert.rejects(sourceRoots(cwd, "unknown"), /Unknown source scope tool/);
  for (const coverage of [
    false,
    null,
    {},
    { excluded: "" },
    { excluded: "  " },
    { excluded: "reason", typo: true },
  ]) {
    await save([{ ...entry, tools: { ...entry.tools, boundary: coverage } }]);
    await assert.rejects(sourceRoots(cwd, "dependency"), /"boundary"/);
  }
  for (const coverage of [
    { dependency: true, duplication: true },
    { ...entry.tools, typo: true },
  ]) {
    await save([{ ...entry, tools: coverage }]);
    await assert.rejects(sourceRoots(cwd, "dependency"), /"tools"/);
  }
  await save([{ ...entry, typo: true }]);
  await assert.rejects(sourceRoots(cwd, "dependency"), /Unrecognized key:.*typo/);
  await save([entry, entry]);
  await assert.rejects(sourceRoots(cwd, "dependency"), /Duplicate production root/);
  await save([{ ...entry, path: "../outside" }]);
  await assert.rejects(sourceRoots(cwd, "dependency"), /Invalid production root/);
  await save([entry]);
  await mkdir(path.join(cwd, "apps/new/custom"), { recursive: true });
  await assert.rejects(
    sourceRoots(cwd, "dependency"),
    /Unclassified production workspace: apps\/new/,
  );
});

test("source scope includes SDK and worker in every gate and validates their roots", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-source-exclusions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(new URL("../source-scope.json", import.meta.url), "utf8"),
  );
  await mkdir(path.join(cwd, "scripts"));
  await writeFile(path.join(cwd, "scripts/source-scope.json"), JSON.stringify(manifest));
  for (const entry of manifest) await mkdir(path.join(cwd, entry.path), { recursive: true });
  const boundary = await sourceRoots(cwd, "boundary");
  const dependency = await sourceRoots(cwd, "dependency");
  const duplication = await sourceRoots(cwd, "duplication");
  for (const directory of ["packages/sdk/src", "services/worker/src"]) {
    assert.ok(boundary.includes(directory));
    assert.ok(dependency.includes(directory));
    assert.ok(duplication.includes(directory));
    assert.equal(manifest.find((entry) => entry.path === directory).tools.boundary, true);
  }
  await rm(path.join(cwd, "packages/sdk/src"), { recursive: true });
  await assert.rejects(sourceRoots(cwd, "boundary"), /Missing production root: packages\/sdk\/src/);
});
