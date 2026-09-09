import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const coverage = z.union([z.literal(true), z.strictObject({ excluded: z.string().trim().min(1) })]);
const classifications = z.strictObject({
  boundary: coverage,
  dependency: coverage,
  duplication: coverage,
});
const scope = z
  .array(
    z.strictObject({
      path: z
        .string()
        .regex(
          /^(?:apps\/[^/.][^/]*\/(?:app|components|lib|src)|(?:packages|services)\/[^/.][^/]*\/src)$/,
          "Invalid production root",
        ),
      tools: classifications,
    }),
  )
  .min(1, "No production roots classified");

async function directories(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function sourceRoots(cwd, tool) {
  assert.ok(Object.hasOwn(classifications.shape, tool), `Unknown source scope tool: ${tool}`);
  const manifest = scope.parse(
    JSON.parse(await readFile(path.join(cwd, "scripts/source-scope.json"), "utf8")),
  );
  const classified = new Set();
  for (const entry of manifest) {
    assert.ok(!classified.has(entry.path), `Duplicate production root: ${entry.path}`);
    classified.add(entry.path);
    let exists = false;
    try {
      exists = (await stat(path.join(cwd, entry.path))).isDirectory();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(exists, `Missing production root: ${entry.path}`);
  }
  for (const parent of ["apps", "packages", "services"]) {
    for (const name of await directories(path.join(cwd, parent))) {
      const workspace = `${parent}/${name}`;
      const roots =
        parent === "apps"
          ? (await directories(path.join(cwd, workspace)))
              .filter((directory) => ["app", "components", "lib", "src"].includes(directory))
              .map((directory) => `${workspace}/${directory}`)
          : [`${workspace}/src`];
      assert.ok(roots.length > 0, `Unclassified production workspace: ${workspace}`);
      for (const directory of roots)
        assert.ok(classified.has(directory), `Unclassified production root: ${directory}`);
    }
  }
  const selected = manifest
    .filter((entry) => entry.tools[tool] === true)
    .map((entry) => entry.path);
  assert.ok(selected.length > 0, `No production roots selected for ${tool}`);
  return selected;
}
