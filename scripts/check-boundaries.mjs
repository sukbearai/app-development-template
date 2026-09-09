import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { sourceRoots } from "./source-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeSource = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const declaration = /\.d\.[cm]?ts$/;
const browserLayers = ["web", "contracts", "sdk"];
const framework = /^(?:next|vinext|react|react-dom)(?:\/|$)/;
const nodeDependencies = /^(?:pg|redis|kafkajs|drizzle-orm|@aws-sdk)(?:\/|$)/;
const layers = {
  web: {
    directory: "apps/web",
    allows: ["web", "contracts", "sdk", "server", "database", "kafka"],
  },
  contracts: { directory: "packages/contracts", allows: ["contracts"], browser: true },
  sdk: { directory: "packages/sdk", allows: ["sdk", "contracts"], browser: true },
  database: { directory: "packages/database", allows: ["database", "contracts"] },
  kafka: { directory: "packages/kafka", allows: ["kafka", "contracts"] },
  server: { directory: "packages/server", allows: ["server", "contracts", "database", "kafka"] },
  worker: {
    directory: "services/worker",
    allows: ["worker", "contracts", "database", "kafka", "server"],
  },
};
function layerOf(file) {
  const relative = path.relative(root, file);
  return Object.keys(layers).find((name) => relative.startsWith(`${layers[name].directory}/`));
}
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory()
          ? sourceFiles(file)
          : runtimeSource.test(file) && !declaration.test(file)
            ? [file]
            : [];
      }),
    )
  ).flat();
}
const roots = await sourceRoots(root, "boundary");
for (const directory of roots)
  assert.ok(layerOf(path.join(root, directory, "index.ts")), `Missing layer policy: ${directory}`);
const files = (
  await Promise.all(roots.map((directory) => sourceFiles(path.join(root, directory))))
).flat();
const modules = new Map();
const configs = new Map();
function compilerOptions(file) {
  const config = ts.findConfigFile(path.dirname(file), ts.sys.fileExists);
  if (!config) return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
  if (!configs.has(config)) {
    const parsed = ts.readConfigFile(config, ts.sys.readFile);
    assert.equal(parsed.error, undefined, `Invalid TypeScript config: ${config}`);
    configs.set(
      config,
      ts.parseJsonConfigFileContent(parsed.config, ts.sys, path.dirname(config)).options,
    );
  }
  return configs.get(config);
}
function existingModule(base) {
  // TypeScript source commonly uses emitted .js specifiers, including ESM/CJS variants.
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  return [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((extension) => [
      stem + extension,
      path.join(base, "index" + extension),
    ]),
  ].find(ts.sys.fileExists);
}
function configuredAlias(source, dependency) {
  return Object.keys(compilerOptions(source).paths ?? {}).some((pattern) => {
    const [prefix, suffix] = pattern.split("*");
    return suffix === undefined
      ? dependency === prefix
      : dependency.startsWith(prefix) && dependency.endsWith(suffix);
  });
}
function resolve(source, dependency) {
  if (configuredAlias(source, dependency))
    return ts.resolveModuleName(dependency, source, compilerOptions(source), ts.sys).resolvedModule
      ?.resolvedFileName;
  if (dependency.startsWith("."))
    return existingModule(path.resolve(path.dirname(source), dependency));
  if (dependency.startsWith("@/"))
    return existingModule(path.join(root, "apps/web", dependency.slice(2)));
  const workspace = /^@pstack\/([^/]+)(?:\/(.*))?$/.exec(dependency);
  if (workspace && layers[workspace[1]])
    return existingModule(
      path.join(root, layers[workspace[1]].directory, "src", workspace[2] || "index"),
    );
  const resolved = ts.resolveModuleName(
    dependency,
    source,
    compilerOptions(source),
    ts.sys,
  ).resolvedModule;
  return resolved?.resolvedFileName;
}
function runtimeSpecifiers(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    const clause = ts.isImportDeclaration(node) ? node.importClause : node;
    if (clause?.isTypeOnly) return [];
    const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
    if (
      !clause?.name &&
      bindings &&
      (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
      bindings.elements.length &&
      bindings.elements.every((element) => element.isTypeOnly)
    )
      return [];
    return [node.moduleSpecifier];
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    !node.isTypeOnly &&
    ts.isExternalModuleReference(node.moduleReference)
  )
    return [node.moduleReference.expression];
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  )
    return [node.arguments[0]];
  return [];
}
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  function visit(node) {
    for (const specifier of runtimeSpecifiers(node))
      if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  modules.set(file, {
    imports,
    layer: layerOf(file),
    client: source.statements.some(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === "use client",
    ),
  });
}
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
  const targetLayer = target && layerOf(target);
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
  if (
    dependency.startsWith(".") ||
    dependency.startsWith("@/") ||
    packageLayer ||
    configuredAlias(file, dependency)
  )
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
