import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isBuiltin } from "node:module";

import { sourceRoots } from "./source-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sourceFiles(path.join(directory, entry.name))
          : /\.(ts|tsx)$/.test(entry.name)
            ? [path.join(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}
const files = (
  await Promise.all(
    (await sourceRoots(root, "boundary")).map((directory) =>
      sourceFiles(path.join(root, directory)),
    ),
  )
).flat();
const modules = new Map();
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!("importClause" in node && node.importClause?.isTypeOnly) && !node.isTypeOnly)
        imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  modules.set(file, {
    imports,
    client: source.statements.some(
      (node) =>
        ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) &&
        node.expression.text === "use client",
    ),
  });
  for (const dependency of imports) {
    if (file.includes("/packages/contracts/"))
      assert.ok(
        !isBuiltin(dependency) &&
          !/^(node:|@pstack\/(server|database|kafka)|next)/.test(dependency),
        `${file}: contracts imports ${dependency}`,
      );
    if (file.includes("/packages/database/"))
      assert.ok(
        !/^(next|vinext|@pstack\/server)/.test(dependency),
        `${file}: database imports ${dependency}`,
      );
    if (file.includes("/packages/server/"))
      assert.ok(
        !/^(next|vinext|@\/)/.test(dependency),
        `${file}: server imports Web ${dependency}`,
      );
  }
}
function resolve(source, dependency) {
  let base;
  if (dependency.startsWith(".")) base = path.resolve(path.dirname(source), dependency);
  else if (dependency.startsWith("@/")) base = path.join(root, "apps/web", dependency.slice(2));
  else if (dependency.startsWith("@pstack/contracts"))
    base = path.join(root, "packages/contracts/src", dependency.split("/")[2] || "index");
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) =>
    modules.has(candidate),
  );
}
function visitClient(file, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const dependency of modules.get(file).imports) {
    assert.ok(
      !isBuiltin(dependency) &&
        !/^(node:|@pstack\/(server|database|kafka)|pg$|redis$|kafkajs$|drizzle-orm|@aws-sdk)/.test(
          dependency,
        ),
      `${file}: browser dependency ${dependency}`,
    );
    const target = resolve(file, dependency);
    if (target)
      assert.ok(
        !target.includes("/packages/server/") &&
          !target.includes("/packages/database/") &&
          !target.includes("/packages/kafka/"),
        `${file}: browser imports ${target}`,
      );
    if (target) visitClient(target, seen);
  }
}
for (const [file, module] of modules) {
  for (const dependency of module.imports) {
    const target = resolve(file, dependency);
    if (!target) continue;
    if (file.includes("/packages/contracts/"))
      assert.ok(target.includes("/packages/contracts/"), `${file}: contracts imports ${target}`);
    if (file.includes("/packages/database/"))
      assert.ok(
        !target.includes("/packages/server/") && !target.includes("/apps/web/"),
        `${file}: database imports ${target}`,
      );
    if (file.includes("/packages/server/"))
      assert.ok(!target.includes("/apps/web/"), `${file}: server imports ${target}`);
  }
  if (module.client) visitClient(file, new Set());
}
console.log(`Module boundaries verified (${modules.size} source modules)`);
