import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { analyzeSources, declaration, layerOf, layers, runtimeSource } from "./source-analysis.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const browserLayers = ["web", "contracts", "sdk"];
const framework = /^(?:next|vinext|react|react-dom)(?:\/|$)/;
const nodeDependencies = /^(?:pg|redis|kafkajs|drizzle-orm|@aws-sdk)(?:\/|$)/;
const { modules, resolve, local } = await analyzeSources(root);
function resolvedPackage(target) {
  if (!target) return undefined;
  const segments = target.split("/node_modules/");
  if (segments.length === 1) return undefined;
  const name = segments.at(-1).match(/^(?:@[^/]+\/)?[^/]+/)?.[0];
  return name?.replace(/^@types\//, "");
}
function checkImport(file, dependency, browser) {
  const layer = modules.get(file).layer;
  const target = resolve(file, dependency);
  const targetLayer = target && layerOf(root, target);
  const packages = [dependency, resolvedPackage(target)].filter(Boolean);
  const packageLayer = /^@pstack\/([^/]+)(?:\/|$)/.exec(dependency)?.[1];
  const destination = targetLayer || packageLayer;
  const description = browser ? "browser" : layer;
  const allows = browser ? browserLayers : layers[layer].allows;
  assert.ok(
    !destination || allows.includes(destination),
    `${file}: ${description} imports ${dependency}`,
  );
  assert.ok(
    layer === "web" || !packages.some((name) => framework.test(name)),
    `${file}: ${layer} imports Web framework ${dependency}`,
  );
  if (browser || layers[layer].browser)
    assert.ok(
      !isBuiltin(dependency) &&
        !dependency.startsWith("node:") &&
        !packages.some((name) => nodeDependencies.test(name)),
      `${file}: ${description} imports Node dependency ${dependency}`,
    );
  if (
    target &&
    !target.includes("/node_modules/") &&
    runtimeSource.test(target) &&
    !declaration.test(target)
  )
    assert.ok(modules.has(target), `${file}: unscanned local dependency ${dependency} (${target})`);
  if (local(file, dependency))
    assert.ok(target, `${file}: unresolved local dependency ${dependency}`);
  return modules.has(target) ? target : undefined;
}
function visitClient(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const dependency of modules.get(file).imports) {
    const target = checkImport(file, dependency, true);
    if (target) visitClient(target, seen);
  }
}
for (const [file, module] of modules) {
  assert.ok(
    !module.client || browserLayers.includes(module.layer),
    `${file}: ${module.layer} cannot be a browser module`,
  );
  for (const dependency of module.imports) checkImport(file, dependency, false);
  if (module.client || layers[module.layer].browser) visitClient(file, new Set());
}
console.log(`Module boundaries verified (${modules.size} source modules)`);
