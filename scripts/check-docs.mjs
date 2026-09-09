#!/usr/bin/env node
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Historical reports describe paths at their recorded revision; their local Markdown links still have to resolve.
const historical = new Set([
  "docs/verification.md",
  "docs/production-repair-results.md",
  "docs/engineering-adoption-plan.md",
]);
const runtimeArtifacts = new Set(["apps/web/.vinext/dev/lock.json"]);
const sourcePath = /^(?:apps|packages|services|scripts|deploy|docs|\.agents)\/[\w./-]+$/;
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function checkDocuments(directory, files) {
  const errors = [];
  let links = 0,
    references = 0,
    features = 0;
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  for (const file of files.filter((name) => name.endsWith(".md"))) {
    const text = await readFile(path.join(directory, file), "utf8");
    const withoutCode = text.replace(/```[^]*?```/g, "");
    for (const match of withoutCode.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      links++;
      let resolved;
      try {
        resolved = decodeURIComponent(target.split(/[?#]/)[0]);
      } catch {
        errors.push(`${file}: malformed link ${target}`);
        continue;
      }
      const destination = path.resolve(path.dirname(path.join(directory, file)), resolved);
      if (!destination.startsWith(`${path.resolve(directory)}/`) || !(await exists(destination)))
        errors.push(`${file}: broken local link ${target}`);
    }
    if (historical.has(file) || file.startsWith("docs/analysis/")) continue;
    for (const [, reference] of text.matchAll(/`([^`\n]+)`/g)) {
      if (!sourcePath.test(reference) || runtimeArtifacts.has(reference)) continue;
      references++;
      if (!(await exists(path.join(directory, reference))))
        errors.push(`${file}: missing example/source path ${reference}`);
    }
    if (file === ".agents/skills/verify-pstack-x/features/README.md") {
      for (const line of text.split("\n").filter((line) => /^\| (?!Feature|---)/.test(line))) {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim());
        features++;
        for (const index of [1, 3]) {
          const paths = (cells[index] ?? "")
            .split(",")
            .map((item) => item.trim().replaceAll("`", ""));
          if (!paths.length || paths.some((item) => !sourcePath.test(item)))
            errors.push(
              `${file}: ${cells[0]} requires explicit ${index === 1 ? "source" : "verification"} paths`,
            );
          for (const item of paths.filter((item) => sourcePath.test(item))) {
            if (!(await exists(path.join(directory, item))))
              errors.push(`${file}: ${cells[0]} missing ${item}`);
          }
        }
      }
    }
  }
  const recipe = JSON.parse(
    await readFile(path.join(directory, "docs/startup-steps.json"), "utf8"),
  );
  const readme = await readFile(path.join(directory, "README.md"), "utf8");
  let previous = -1;
  for (const args of Object.values(recipe)) {
    const command = `pnpm ${args.join(" ")}`;
    const position = readme.indexOf(command, previous + 1);
    if (position < 0) errors.push(`README.md: missing or out-of-order startup command ${command}`);
    else previous = position;
    if (args[0] !== "install" && !manifest.scripts[args[0]])
      errors.push(`package.json: missing startup script ${args[0]}`);
  }
  if (!features) errors.push("Feature map has no verifiable rows");
  return { files: files.length, links, references, features, errors };
}
export async function docsMain(args = process.argv.slice(2)) {
  const runId = randomUUID();
  let data = null,
    status = "passed",
    errorCode = null;
  try {
    if (args.some((arg) => arg !== "--json") || args.length > 1)
      throw Object.assign(new Error("Only --json is supported."), { code: "INVALID_ARGUMENT" });
    const files = [
      ...new Set(
        execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
          cwd: root,
        })
          .toString()
          .split("\0"),
      ),
    ].filter(
      (file) =>
        file === "README.md" ||
        file.startsWith("docs/") ||
        /^(?:packages|services)\/[^/]+\/README\.md$/.test(file) ||
        file.startsWith(".agents/skills/verify-pstack-x/"),
    );
    data = await checkDocuments(root, files);
    if (data.errors.length) {
      status = "failed";
      errorCode = "DOCS_STALE";
    }
  } catch (error) {
    status = error.code === "INVALID_ARGUMENT" ? "invalid" : "failed";
    errorCode = error.code === "INVALID_ARGUMENT" ? error.code : "DOCS_CHECK_FAILED";
    data = { errors: [error.message] };
  }
  const result = commandResult({ command: "docs:check", runId, status, errorCode, data });
  if (!args.includes("--json") && data.errors.length)
    process.stderr.write(`${data.errors.join("\n")}\n`);
  printCommandResult(result, args.includes("--json"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await docsMain();
