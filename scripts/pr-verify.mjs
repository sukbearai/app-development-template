#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseArguments(args) {
  const options = { base: "HEAD", full: false, ui: false, summary: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    if (args[i] === "--full") options.full = true;
    else if (args[i] === "--ui") options.ui = true;
    else if (args[i] === "--no-summary") options.summary = false;
    else if (args[i] === "--base") {
      options.base = args[++i];
      if (!options.base || options.base.startsWith("-")) throw new Error("--base requires a git ref");
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}
export function verificationPlan(files, options) {
  // Unknown paths and clean checkouts receive the same core checks as application changes.
  const gates = ["lint", "duplication:check", "boundary:check", "typecheck", "contract:check", "migration:check", "test:tools", "test:unit", "test:integration", "build"];
  if (options.full) gates.push("db:integration", "test:e2e", "test:ui", "test:ui:production", "test:async-recovery", "test:kafka-security");
  else if (options.ui || files.some((file) => /^(apps\/web\/|packages\/server\/|packages\/contracts\/)/.test(file))) gates.push("test:ui");
  return [...new Set(gates)];
}
async function changedFiles(base) {
  let diff;
  try { diff = await run("git", ["diff", "--name-only", "-z", base, "--"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    if (base !== "HEAD") throw error;
    let hasHead = true;
    try { await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" }); } catch { hasHead = false; }
    if (hasHead) throw error;
    diff = await run("git", ["ls-files", "-z"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  }
  const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  return [...new Set((diff + untracked).split("\0").filter(Boolean))].sort();
}
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = await changedFiles(options.base);
  const plan = verificationPlan(files, options);
  const results = [];
  let failure;
  try {
    await run("git", ["diff", "--check"], { cwd: root });
    await run("git", ["diff", "--cached", "--check"], { cwd: root });
    for (const gate of plan) {
      console.log(`> pnpm ${gate}`);
      try { await run("pnpm", [gate], { cwd: root }); results.push({ gate, status: "passed" }); }
      catch (error) { results.push({ gate, status: "failed" }); throw error; }
    }
  } catch (error) { failure = error; }
  for (const gate of plan) if (!results.some((result) => result.gate === gate)) results.push({ gate, status: "not run after failure" });
  if (options.summary) {
    const directory = path.join(root, "artifacts/pr-verify");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "summary.json"), JSON.stringify({ base: options.base, full: options.full, files, results, passed: !failure }, null, 2) + "\n");
  }
  if (failure) throw failure;
  console.log(`PR verification passed (${plan.length} gates, ${files.length} changed files)`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
