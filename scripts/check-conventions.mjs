import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { analyzeSources, declaration, layers, runtimeSource } from "./source-analysis.mjs";
import {
  moduleEntrypoints,
  moduleIdentity,
  platformFiles,
  publicEntrypoint,
  sameModule,
} from "./convention-policy.mjs";

const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const miscellaneous = /^(?:utils|common|helpers|manager)$/;
const appReserved =
  /^(?:page|layout|template|loading|error|global-error|not-found|default|route|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.[cm]?[jt]sx?$/;

function checkLocation(file, layer, report) {
  if (layer === "kafka" || layer === "sdk") return;
  const local = file.slice(layers[layer].directory.length + 1);
  const parts = local.split("/");
  const stem = parts.at(-1).replace(/\.[^.]+$/, "");
  for (const [index, part] of parts.entries()) {
    const name = index === parts.length - 1 ? stem : part;
    if (layer === "web" && parts[0] === "app" && index > 0 && index < parts.length - 1) continue;
    if (!kebab.test(name)) report("file-name", `Use kebab-case for ${part}`);
    if (miscellaneous.test(name))
      report(
        "module-name",
        `Name ${part} after its responsibility instead of a miscellaneous container`,
      );
  }
  if (layer === "web") {
    if (parts[0] === "components") {
      if (parts.length < 3)
        report(
          "component-location",
          "Place components in components/<domain>, ui, providers or admin",
        );
      if (stem.startsWith("use-") || /(?:^|-)(?:client|policy)$/.test(stem))
        report(
          "client-location",
          "Place request clients and policies in lib, and shared hooks in lib/hooks",
        );
    }
    if (parts[0] === "lib" && parts.length === 2 && stem.startsWith("use-"))
      report("hook-location", "Place shared hooks in lib/hooks");
    if (parts[0] === "lib" && parts[1] === "hooks" && !stem.startsWith("use-"))
      report("hook-name", "Name shared hook files use-<subject>");
    return;
  }
  const module = moduleIdentity(file);
  if (!module) {
    if (!platformFiles[layer].includes(parts.slice(1).join("/")))
      report(
        "source-location",
        "Place business code in src/modules/<domain>; new platform files require an explicit policy review",
      );
    return;
  }
  if (/^index\.[^.]+$/.test(module.file) || module.file.startsWith("index/"))
    report(
      "module-index",
      "Import the responsibility entrypoint directly; modules do not have index barrels",
    );
  const role = /^(contracts|repository|service|router|handler)\.ts$/.exec(module.file)?.[0];
  if (role && !moduleEntrypoints[layer].includes(role))
    report("module-role", `${role} belongs in its owning package`);
}

function environmentReader(source) {
  const scopes = new Map();
  const processModules = new Set(["process", "node:process"]);
  const isProcessModule = (node) =>
    node && ts.isStringLiteralLike(node) && processModules.has(node.text);
  function bindings(scope) {
    if (scopes.has(scope)) return scopes.get(scope);
    const names = new Map();
    function bind(name, declaration) {
      if (ts.isIdentifier(name)) names.set(name.text, declaration);
      else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
        for (const element of name.elements)
          if (ts.isBindingElement(element)) bind(element.name, element);
    }
    for (const parameter of scope.parameters ?? []) bind(parameter.name, parameter);
    if (
      (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer)
    )
      for (const declaration of scope.initializer.declarations) bind(declaration.name, declaration);
    for (const statement of scope.statements ?? []) {
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          bind(declaration.name, declaration);
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      )
        bind(statement.name, statement);
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        if (clause.name) bind(clause.name, clause);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings))
            bind(clause.namedBindings.name, clause.namedBindings);
          else for (const element of clause.namedBindings.elements) bind(element.name, element);
        }
      }
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration)
      bind(scope.variableDeclaration.name, scope.variableDeclaration);
    scopes.set(scope, names);
    return names;
  }
  function declarationOf(identifier) {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      const declaration = bindings(scope).get(identifier.text);
      if (declaration) return declaration;
    }
    return undefined;
  }
  function importedProcess(node) {
    let declaration = node;
    while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
    return (
      declaration &&
      !declaration.importClause?.isTypeOnly &&
      isProcessModule(declaration.moduleSpecifier)
    );
  }
  function processReference(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    )
      return processReference(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const declaration = declarationOf(node);
      if (!declaration) return node.text === "process";
      if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))
        return Boolean(importedProcess(declaration));
      if (ts.isImportSpecifier(declaration))
        return (
          !declaration.isTypeOnly &&
          (declaration.propertyName ?? declaration.name).text === "default" &&
          Boolean(importedProcess(declaration))
        );
      if (ts.isVariableDeclaration(declaration))
        return processReference(declaration.initializer, seen);
      return false;
    }
    return (
      ts.isCallExpression(node) &&
      isProcessModule(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    );
  }
  return (node) => {
    if (ts.isPropertyAccessExpression(node))
      return node.name.text === "env" && processReference(node.expression);
    if (ts.isElementAccessExpression(node))
      return (
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "env" &&
        processReference(node.expression)
      );
    if (
      ts.isBindingElement(node) &&
      (node.propertyName ?? node.name).getText(source).replace(/^["']|["']$/g, "") === "env"
    ) {
      const owner = node.parent.parent;
      return ts.isVariableDeclaration(owner) && processReference(owner.initializer);
    }
    return (
      ts.isImportSpecifier(node) &&
      !node.isTypeOnly &&
      (node.propertyName ?? node.name).text === "env" &&
      Boolean(importedProcess(node))
    );
  };
}

function checkSyntax(file, module, report) {
  const readsEnvironment = environmentReader(module.source);
  const frameworkDefault =
    file.startsWith("apps/web/app/") && appReserved.test(path.basename(file));
  function visit(node) {
    const modifiers = node.modifiers ?? [];
    if (
      file.startsWith("apps/web/lib/") &&
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    )
      report(
        "component-location",
        "Place JSX components in components/<domain>, ui, providers or admin",
      );
    if (
      !frameworkDefault &&
      (ts.isExportAssignment(node) ||
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ||
        (ts.isExportSpecifier(node) && node.name.text === "default"))
    )
      report("named-export", "Use named exports outside App Router reserved files");
    if (moduleIdentity(file) && readsEnvironment(node))
      report(
        "module-environment",
        "Read environment configuration at the existing platform configuration boundary",
      );
    ts.forEachChild(node, visit);
  }
  visit(module.source);
}

function checkEdge(file, edge, analysis, report) {
  const target = analysis.resolve(file, edge.dependency);
  if (!target) {
    if (analysis.local(file, edge.dependency))
      report("unresolved-import", `Resolve local dependency ${edge.dependency}`);
    return;
  }
  if (target.includes("/node_modules/")) return;
  if (runtimeSource.test(target) && !declaration.test(target) && !analysis.modules.has(target))
    report(
      "unscanned-import",
      `Include local dependency ${edge.dependency} in the existing source scope`,
    );
  const relative = path.relative(analysis.root, file);
  const destination = path.relative(analysis.root, target);
  const sourceModule = moduleIdentity(relative);
  const targetModule = moduleIdentity(destination);
  if (sourceModule && destination === `${sourceModule.workspace}/src/index.ts`)
    report(
      "module-barrel",
      "Import platform capabilities or module responsibility files directly, not the package index",
    );
  if (
    sourceModule?.layer === "worker" &&
    !targetModule &&
    /^services\/worker\/src\/(?:async-consumer|async-task-store|async-runtime|domain-handler|index|outbox)\.ts$/.test(
      destination,
    )
  )
    report("worker-direction", "Worker modules must not import the platform scheduler");
  if (!targetModule) return;
  if (edge.reexport && relative === `${targetModule.workspace}/src/index.ts`)
    report(
      "module-barrel",
      "Import business entrypoints directly; do not aggregate them in the platform index",
    );
  if (!sameModule(sourceModule, targetModule) && !publicEntrypoint(targetModule))
    report(
      "private-import",
      `Import ${targetModule.workspace}/src/modules/${targetModule.domain}/${moduleEntrypoints[targetModule.layer].join(" or ")} instead of private ${edge.dependency}`,
    );
  if (
    edge.reexport &&
    !publicEntrypoint(targetModule) &&
    (!sameModule(sourceModule, targetModule) || publicEntrypoint(sourceModule))
  )
    report(
      "private-reexport",
      `Keep ${edge.dependency} private; export behavior implemented by the public responsibility file`,
    );
  if (targetModule.file === "router.ts" && relative !== "packages/server/src/trpc-router.ts")
    report("router-import", "Only the root server trpc-router.ts assembles module routers");
  if (
    targetModule.layer === "worker" &&
    targetModule.file === "handler.ts" &&
    !relative.startsWith("services/worker/src/")
  )
    report(
      "handler-import",
      "Only worker scheduling and handler mapping may import worker handlers",
    );
}

export async function checkSourceConventions(root) {
  const analysis = { ...(await analyzeSources(root)), root };
  const findings = [];
  for (const [file, module] of analysis.modules) {
    const relative = path.relative(root, file);
    const report = (rule, message) => findings.push({ file: relative, rule, message });
    checkLocation(relative, module.layer, report);
    if (module.layer !== "sdk") checkSyntax(relative, module, report);
    for (const edge of module.edges) checkEdge(file, edge, analysis, report);
  }
  return { findings, roots: analysis.roots };
}

export async function checkConventions(root) {
  const { findings, roots } = await checkSourceConventions(root);
  const { inspectTestLayout } = await import("./test-discovery.mjs");
  const workspaces = [
    ...new Set(roots.map((directory) => directory.split("/").slice(0, 2).join("/"))),
  ];
  for (const workspace of workspaces) {
    const manifest = JSON.parse(await readFile(path.join(root, workspace, "package.json"), "utf8"));
    const declaredSuites = new Set();
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (name !== "test:unit" && name !== "test:integration") continue;
      if (name === "test:unit") declaredSuites.add("unit");
      if (name === "test:integration") declaredSuites.add("integration");
      for (const invocation of command.matchAll(/(?:^|\s)[^\s]*run-tests\.mjs\s+([^;&|]+)/g))
        for (const argument of invocation[1].trim().split(/\s+/))
          if (["unit", "integration", "web-runtime"].includes(argument))
            declaredSuites.add(argument);
    }
    const layout = await inspectTestLayout(path.join(root, workspace), [...declaredSuites]);
    for (const finding of layout.findings)
      findings.push({ ...finding, file: `${workspace}/${finding.file}` });
    for (const [suite, files] of Object.entries(layout.files)) {
      if (files.length && !declaredSuites.has(suite))
        findings.push({
          file: `${workspace}/tests/${suite}`,
          rule: "test-unexecuted",
          message: "Connect this suite to the workspace test:unit or test:integration command",
        });
      if (
        suite === "web-runtime" &&
        workspace !== "packages/server" &&
        (files.length || declaredSuites.has(suite))
      )
        findings.push({
          file: `${workspace}/tests/${suite}`,
          rule: "test-workspace",
          message: "The web-runtime suite belongs only to packages/server",
        });
    }
  }
  return findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.rule.localeCompare(right.rule),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await checkConventions(fileURLToPath(new URL("../", import.meta.url)));
  for (const finding of findings)
    console.error(`${finding.file}: [${finding.rule}] ${finding.message}`);
  if (findings.length) process.exitCode = 1;
  else console.log("Source and test conventions verified");
}
