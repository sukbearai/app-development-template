#!/usr/bin/env node
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.mjs";
import { commandResult, printCommandResult, runLogged } from "./engineering-command.mjs";
import {
  createEvidenceRun,
  evidenceReference,
  sourceIdentity,
  writeEvidenceIndex,
} from "./verification-evidence.mjs";
import { CORE_GATES, FULL_GATES, RELEASE_GATES } from "./verification-plan.mjs";
import { validateGateReports } from "./gate-reports.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseArguments(args) {
  const options = {
    base: "HEAD",
    full: false,
    ui: false,
    summary: true,
    json: false,
    containers: false,
    release: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    if (args[i] === "--full") options.full = true;
    else if (args[i] === "--json") options.json = true;
    else if (args[i] === "--containers") options.containers = true;
    else if (args[i] === "--release") {
      options.release = true;
      options.full = true;
      options.containers = true;
    } else if (args[i] === "--ui") options.ui = true;
    else if (args[i] === "--no-summary") options.summary = false;
    else if (args[i] === "--base") {
      options.base = args[++i];
      if (!options.base || options.base.startsWith("-"))
        throw new Error("--base requires a git ref");
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}
export function verificationPlan(files, options) {
  // Unknown paths and clean checkouts receive the same core checks as application changes.
  if (options.release) return [...RELEASE_GATES];
  const gates = [...CORE_GATES];
  if (options.full) gates.push(...FULL_GATES);
  else if (
    options.ui ||
    files.some((file) => /^(apps\/web\/|packages\/server\/|packages\/contracts\/)/.test(file))
  )
    gates.push("test:ui");
  if (options.containers) gates.push("test:containers");
  return [...new Set(gates)];
}
async function changedFiles(base) {
  let diff;
  try {
    diff = await run("git", ["diff", "--name-only", "-z", base, "--"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (base !== "HEAD") throw error;
    let hasHead = true;
    try {
      await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
    } catch {
      hasHead = false;
    }
    if (hasHead) throw error;
    diff = await run("git", ["ls-files", "-z"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  }
  const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return [...new Set((diff + untracked).split("\0").filter(Boolean))].sort();
}
async function reportsSince(directory, since) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await reportsSince(file, since)));
    else if (
      entry.isFile() &&
      /\.(json|png|zip|log|txt)$/.test(entry.name) &&
      (await stat(file)).mtimeMs >= since
    )
      files.push(file);
  }
  return files;
}
async function main(options) {
  const files = await changedFiles(options.base);
  const plan = verificationPlan(files, options);
  const evidenceRun = await createEvidenceRun(root);
  const results = [];
  const checks = [];
  const interruption = new AbortController();
  const interrupt = () => interruption.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let failure;
  try {
    await run("git", ["diff", "--check"], { cwd: root });
    await run("git", ["diff", "--cached", "--check"], { cwd: root });
    for (const gate of plan) {
      const started = Date.now();
      const logFile = path.join(
        evidenceRun.output,
        `${checks.length}-${gate.replaceAll(":", "-")}.log`,
      );
      const commandArgs =
        gate === "test:containers" && process.env.PSTACK_RELEASE_OUTPUT
          ? [gate, "--export", process.env.PSTACK_RELEASE_OUTPUT]
          : [gate];
      const outcome = await runLogged({
        command: "pnpm",
        args: commandArgs,
        cwd: root,
        logFile,
        signal: interruption.signal,
      });
      let status = outcome.code === 0 && !outcome.interrupted ? "passed" : "failed";
      const reports = await reportsSince(path.join(root, ".verification"), started);
      if (status === "passed") {
        try {
          await validateGateReports(gate, reports, root, evidenceRun.source);
        } catch {
          status = "failed";
        }
      }
      results.push({ gate, status });
      checks.push({
        name: gate,
        status,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        evidence: await Promise.all(
          [logFile, ...reports].map((file) => evidenceReference(root, file)),
        ),
      });
      if (status !== "passed")
        throw new Error(outcome.interrupted ? "interrupted" : "check_failed");
    }
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(evidenceRun.source))
      throw new Error("source_changed");
    interruption.signal.throwIfAborted();
  } catch (error) {
    failure = error;
  }
  for (const gate of plan)
    if (!results.some((result) => result.gate === gate)) {
      results.push({ gate, status: "not run after failure" });
      const logFile = path.join(evidenceRun.output, `${checks.length}-not-run.log`);
      await writeFile(logFile, "Not run after prerequisite or command failure.\n", { flag: "wx" });
      const now = new Date().toISOString();
      checks.push({
        name: gate,
        status: "not-run",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        evidence: [await evidenceReference(root, logFile)],
      });
    }
  if (options.summary) {
    const directory = path.join(root, "artifacts/pr-verify");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify(
        { base: options.base, full: options.full, files, results, passed: !failure },
        null,
        2,
      ) + "\n",
    );
  }
  const indexFile = await writeEvidenceIndex(
    root,
    evidenceRun,
    checks,
    failure || interruption.signal.aborted ? "failed" : "passed",
  );
  if (interruption.signal.aborted) {
    failure = new Error("interrupted");
    const index = JSON.parse(await readFile(indexFile, "utf8"));
    index.status = "failed";
    await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  const status = interruption.signal.aborted ? "interrupted" : failure ? "failed" : "passed";
  printCommandResult(
    commandResult({
      command: "pr:verify",
      runId: evidenceRun.runId,
      status,
      errorCode: failure ? "verification_failed" : null,
      evidence: path.relative(root, indexFile),
      data: { gates: results },
    }),
    options.json,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    printCommandResult(
      commandResult({ command: "pr:verify", status: "invalid", errorCode: "invalid_arguments" }),
      process.argv.includes("--json"),
    );
  }
  if (options)
    main(options).catch(() => {
      printCommandResult(
        commandResult({
          command: "pr:verify",
          status: "failed",
          errorCode: "verification_setup_failed",
        }),
        options.json,
      );
    });
}
