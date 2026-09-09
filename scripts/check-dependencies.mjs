import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultOptions, parseCircular, parseDependencyTree } from "dpdm";
import ts from "typescript";

import { sourceRoots } from "./source-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const unsupportedExtensions = new Set([".cjs", ".cts", ".mts"]);
const declarationFile = /\.d\.(?:ts|cts|mts)$/;
const dependencyDirectory = /(?:^|[/\\])node_modules(?:[/\\]|$)/;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules")
      files.push(...(await sourceFiles(filename)));
    else if (
      !declarationFile.test(filename) &&
      (defaultOptions.js.includes(path.extname(filename)) ||
        unsupportedExtensions.has(path.extname(filename)))
    )
      files.push(filename);
  }
  return files;
}

function inspectSource(filename, source) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  let ignoredComment = false;
  const unsupportedDynamicImports = [];
  const visit = (node) => {
    const comments = [
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ];
    if (comments.some(({ pos, end }) => source.slice(pos, end).includes("@dpdm-ignore")))
      ignoredComment = true;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
    )
      unsupportedDynamicImports.push({ issuer: filename, request: node.arguments[0].text });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { ignoredComment, unsupportedDynamicImports };
}

async function frameworkShim(cwd, issuer, request) {
  if (
    !issuer.startsWith("apps/web/") ||
    !["next/headers", "next/link", "next/navigation"].includes(request)
  )
    return undefined;
  try {
    const require = createRequire(pathToFileURL(path.join(cwd, issuer)));
    for (const directory of require.resolve.paths("vinext")) {
      const manifest = path.join(directory, "vinext/package.json");
      let content;
      try {
        content = await readFile(manifest, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const metadata = JSON.parse(content);
      if (metadata.name !== "vinext") return undefined;
      const target = metadata.exports["./shims/*"].import.replace("*", request.slice(5));
      const shim = path.resolve(path.dirname(manifest), target);
      return (await stat(shim)).isFile() ? path.relative(cwd, shim) : undefined;
    }
  } catch (error) {
    if (!["ENOENT", "ERR_MODULE_NOT_FOUND"].includes(error.code)) throw error;
  }
  return undefined;
}

export async function checkDependencies({ cwd = root } = {}) {
  const reportPath = path.join(cwd, "artifacts/quality/dependencies/report.json");
  await rm(reportPath, { force: true });
  const roots = await sourceRoots(cwd, "dependency");
  const entries = [];
  for (const directory of roots) {
    const files = await sourceFiles(path.join(cwd, directory));
    if (!files.length) throw new Error(`Empty production root: ${directory}`);
    entries.push(...files.map((filename) => path.relative(cwd, filename)));
  }
  entries.sort();
  const tree = await parseDependencyTree(
    entries.map((entry) => entry.replace(/[[\]*?{}()+@]/g, "[$&]")),
    {
      cwd,
      context: cwd,
      transform: true,
      skipDynamicImports: false,
      exclude: dependencyDirectory,
    },
  );
  const scannedFiles = [];
  const skippedLocal = [];
  const ignoredComments = [];
  const unsupportedFiles = [];
  const unsupportedDynamicImports = [];
  const assets = [];
  const missing = [];
  const external = [];
  for (const [filename, dependencies] of Object.entries(tree).sort()) {
    if (isBuiltin(filename)) continue;
    if (dependencyDirectory.test(filename)) {
      if (!dependencyDirectory.test(await realpath(path.resolve(cwd, filename))))
        skippedLocal.push(filename);
      continue;
    }
    if (!Array.isArray(dependencies)) {
      skippedLocal.push(filename);
      continue;
    }
    if (declarationFile.test(filename)) continue;
    if (unsupportedExtensions.has(path.extname(filename))) {
      unsupportedFiles.push(filename);
      continue;
    }
    if (!defaultOptions.js.includes(path.extname(filename))) {
      assets.push(filename);
      continue;
    }
    scannedFiles.push(filename);
    const inspection = inspectSource(filename, await readFile(path.resolve(cwd, filename), "utf8"));
    if (inspection.ignoredComment) ignoredComments.push(filename);
    unsupportedDynamicImports.push(...inspection.unsupportedDynamicImports);
    for (const { request, id } of dependencies) {
      const edge = { issuer: filename, request };
      if (isBuiltin(request)) external.push({ ...edge, kind: "builtin" });
      else if (id === null) {
        const shim = await frameworkShim(cwd, filename, request);
        if (shim) external.push({ ...edge, kind: "vinext", resolved: shim });
        else missing.push(edge);
      } else if (dependencyDirectory.test(id))
        external.push({ ...edge, kind: "package", resolved: id });
    }
  }
  const uncoveredEntries = entries.filter((entry) => !Array.isArray(tree[entry]));
  const circulars = parseCircular(tree);
  const report = {
    version: 1,
    counts: {
      roots: roots.length,
      entries: entries.length,
      scannedFiles: scannedFiles.length,
      circulars: circulars.length,
      missing: missing.length,
      external: external.length,
    },
    entries,
    scannedFiles,
    circulars,
    missing,
    external,
    skippedLocal,
    uncoveredEntries,
    ignoredComments,
    unsupportedFiles,
    unsupportedDynamicImports,
    assets,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const failures = [
    ...circulars.map((cycle) => `Runtime cycle: ${[...cycle, cycle[0]].join(" -> ")}`),
    ...missing.map(({ issuer, request }) => `Missing dependency: ${issuer} -> ${request}`),
    ...skippedLocal.map((filename) => `Skipped local module: ${filename}`),
    ...uncoveredEntries.map((filename) => `Uncovered entry: ${filename}`),
    ...unsupportedFiles.map((filename) => `Unsupported local source extension: ${filename}`),
    ...unsupportedDynamicImports.map(
      ({ issuer, request }) =>
        `Unsupported literal dynamic import signature: ${issuer} -> ${request}`,
    ),
    ...ignoredComments.map((filename) => `Forbidden @dpdm-ignore comment: ${filename}`),
  ];
  if (failures.length) throw new Error(failures.join("\n"));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("dependency:check accepts no arguments");
    const report = await checkDependencies();
    console.log(
      `Dependencies verified: ${report.counts.entries} entries, ${report.counts.scannedFiles} files, ${report.counts.external} external edges`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
