import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { sourceRoots } from "./source-scope.mjs";

export const runtimeSource = /\.(?:[cm]?[jt]s|[jt]sx)$/;
export const declaration = /\.d\.[cm]?ts$/;
export const layers = {
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

export function layerOf(root, file) {
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

function existingModule(base) {
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  return [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((extension) => [
      stem + extension,
      path.join(base, "index" + extension),
    ]),
  ].find(ts.sys.fileExists);
}

export function createResolver(root) {
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
      return ts.resolveModuleName(dependency, source, compilerOptions(source), ts.sys)
        .resolvedModule?.resolvedFileName;
    if (dependency.startsWith("."))
      return existingModule(path.resolve(path.dirname(source), dependency));
    if (dependency.startsWith("@/"))
      return existingModule(path.join(root, "apps/web", dependency.slice(2)));
    const workspace = /^@pstack\/([^/]+)(?:\/(.*))?$/.exec(dependency);
    if (workspace && layers[workspace[1]])
      return existingModule(
        path.join(root, layers[workspace[1]].directory, "src", workspace[2] || "index"),
      );
    return ts.resolveModuleName(dependency, source, compilerOptions(source), ts.sys).resolvedModule
      ?.resolvedFileName;
  }
  function local(source, dependency) {
    return (
      dependency.startsWith(".") ||
      dependency.startsWith("@/") ||
      dependency.startsWith("@pstack/") ||
      configuredAlias(source, dependency)
    );
  }
  return { resolve, local };
}

function declarationEdge(node) {
  const importing = ts.isImportDeclaration(node);
  const clause = importing ? node.importClause : node;
  const bindings = importing ? clause?.namedBindings : node.exportClause;
  const named = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings));
  const typeOnly = Boolean(
    clause?.isTypeOnly ||
    (!clause?.name &&
      named &&
      bindings.elements.length &&
      bindings.elements.every((element) => element.isTypeOnly)),
  );
  const names = importing
    ? [
        clause?.name?.text,
        ...(named
          ? bindings.elements.map((element) => element.name.text)
          : bindings?.name
            ? [bindings.name.text]
            : []),
      ].filter(Boolean)
    : [];
  return { specifier: node.moduleSpecifier, typeOnly, reexport: !importing, names };
}

function syntaxEdge(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
    return declarationEdge(node);
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return {
      specifier: node.moduleReference.expression,
      typeOnly: node.isTypeOnly,
      reexport: Boolean(
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      ),
      names: [node.name.text],
    };
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return { specifier: node.argument.literal, typeOnly: true, reexport: false, names: [] };
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  )
    return { specifier: node.arguments[0], typeOnly: false, reexport: false, names: [] };
  return undefined;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingNames(element.name) : [],
    );
  return [];
}

function exportedBinding(node) {
  let current = node;
  while (
    current.parent &&
    ((current.parent.expression === current &&
      (ts.isAwaitExpression(current.parent) ||
        ts.isParenthesizedExpression(current.parent) ||
        ts.isPropertyAccessExpression(current.parent) ||
        ts.isElementAccessExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isNonNullExpression(current.parent))) ||
      (ts.isTypeQueryNode(current.parent) && current.parent.exprName === current) ||
      (ts.isParenthesizedTypeNode(current.parent) && current.parent.type === current))
  )
    current = current.parent;
  if (ts.isVariableDeclaration(current.parent) && current.parent.initializer === current) {
    const declaration = current.parent;
    const statement = declaration.parent.parent;
    return {
      names: bindingNames(declaration.name),
      reexport:
        ts.isVariableStatement(statement) &&
        Boolean(
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
        ),
    };
  }
  if (ts.isTypeAliasDeclaration(current.parent) && current.parent.type === current)
    return {
      names: [current.parent.name.text],
      reexport: Boolean(
        current.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      ),
    };
  return { names: [], reexport: false };
}

function referenceName(node) {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return referenceName(node.expression);
  if (ts.isTypeReferenceNode(node)) return referenceName(node.typeName);
  if (ts.isTypeQueryNode(node)) return referenceName(node.exprName);
  if (ts.isParenthesizedTypeNode(node)) return referenceName(node.type);
  if (ts.isQualifiedName(node)) return referenceName(node.left);
  return undefined;
}

function exportedAliases(source, exported) {
  const aliases = new Map();
  for (const statement of source.statements) {
    const isExport = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    const bindings = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : ts.isTypeAliasDeclaration(statement)
        ? [statement]
        : [];
    for (const binding of bindings) {
      const names = bindingNames(binding.name);
      const reference = referenceName(
        ts.isTypeAliasDeclaration(binding) ? binding.type : binding.initializer,
      );
      for (const name of names) {
        if (isExport) exported.add(name);
        if (reference) aliases.set(name, reference);
      }
    }
  }
  for (const name of exported) {
    const reference = aliases.get(name);
    if (reference) exported.add(reference);
  }
}

export function parseSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges = [];
  const exported = new Set();
  function visit(node) {
    const edge = syntaxEdge(node);
    if (edge && (ts.isCallExpression(node) || ts.isImportTypeNode(node)))
      Object.assign(edge, exportedBinding(node));
    if (edge?.specifier && ts.isStringLiteralLike(edge.specifier))
      edges.push({
        dependency: edge.specifier.text,
        typeOnly: edge.typeOnly,
        reexport: edge.reexport,
        names: edge.names,
      });
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    )
      for (const element of node.exportClause.elements)
        exported.add((element.propertyName ?? element.name).text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  exportedAliases(source, exported);
  for (const edge of edges) if (edge.names.some((name) => exported.has(name))) edge.reexport = true;
  return {
    source,
    edges,
    imports: edges.filter((edge) => !edge.typeOnly).map((edge) => edge.dependency),
    client: source.statements.some(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === "use client",
    ),
  };
}

export async function analyzeSources(root) {
  const roots = await sourceRoots(root, "boundary");
  for (const directory of roots)
    assert.ok(
      layerOf(root, path.join(root, directory, "index.ts")),
      `Missing layer policy: ${directory}`,
    );
  const files = (
    await Promise.all(roots.map((directory) => sourceFiles(path.join(root, directory))))
  )
    .flat()
    .sort();
  const modules = new Map(
    await Promise.all(
      files.map(async (file) => [
        file,
        { ...parseSource(file, await readFile(file, "utf8")), layer: layerOf(root, file) },
      ]),
    ),
  );
  return { modules, roots, ...createResolver(root) };
}
