#!/usr/bin/env node
import { mkdir, writeFile, readFile, readdir, appendFile } from "node:fs/promises";
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
import {
  CORE_GATES,
  FULL_GATES,
  RELEASE_GATES,
  TEMPLATE_GATES,
  gateCommand,
} from "./verification-plan.mjs";
import { validateGateReports } from "./gate-reports.mjs";
import {
  scheduleVerification,
  validateConcurrency,
  withVerificationLock,
} from "./verification-scheduler.mjs";
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
    template: false,
    concurrency: 2,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    if (args[i] === "--template") options.template = true;
    else if (args[i] === "--concurrency") {
      const value = args[++i];
      if (!/^[1-4]$/.test(value ?? "")) throw new Error("Invalid concurrency");
      options.concurrency = validateConcurrency(Number(value));
    } else if (args[i] === "--full") options.full = true;
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
  if (options.template && (options.full || options.ui || options.containers || options.release))
    throw new Error("--template cannot be combined with another profile");
  return options;
}
export function verificationPlan(files, options) {
  // Unknown paths and clean checkouts receive the same core checks as application changes.
  if (options.template) return [...TEMPLATE_GATES];
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
async function gateReports(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await gateReports(file)));
    else if (entry.isFile() && /\.(json|png|zip|log|txt)$/.test(entry.name)) files.push(file);
  }
  return files;
}
async function main(options, signal) {
  const files = await changedFiles(options.base);
  const plan = verificationPlan(files, options);
  const evidenceRun = await createEvidenceRun(root);
  const results = [];
  const checks = [];
  let failure;
  try {
    await run("git", ["diff", "--check"], { cwd: root });
    await run("git", ["diff", "--cached", "--check"], { cwd: root });
    const scheduled = await scheduleVerification(
      plan,
      async (gate, commandSignal) => {
        const started = Date.now();
        const logFile = path.join(
          evidenceRun.output,
          `${plan.indexOf(gate)}-${gate.replaceAll(":", "-")}.log`,
        );
        const evidenceRoot = path.join(
          root,
          ".verification",
          `verify-${evidenceRun.runId}`,
          gate.replaceAll(":", "-"),
        );
        let status = "failed";
        let evidence = [];
        try {
          await mkdir(evidenceRoot, { recursive: true });
          signal.throwIfAborted();
          const outcome = await runLogged({
            ...gateCommand(gate, process.env.PSTACK_RELEASE_OUTPUT),
            cwd: root,
            logFile,
            env: { ...process.env, PSTACK_VERIFICATION_ROOT: evidenceRoot },
            signal: commandSignal,
          });
          const reports = await gateReports(evidenceRoot);
          evidence = await Promise.all(reports.map((file) => evidenceReference(root, file)));
          if (outcome.code !== 0 || outcome.interrupted) throw new Error("check_failed");
          await validateGateReports(gate, reports, root, evidenceRun.source, { evidenceRoot });
          signal.throwIfAborted();
          status = "passed";
        } catch (error) {
          await appendFile(logFile, `\nVerification failed: ${error.message}\n`);
        }
        evidence.unshift(await evidenceReference(root, logFile));
        return {
          status,
          check: {
            name: gate,
            status,
            startedAt: new Date(started).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            evidence,
          },
        };
      },
      { concurrency: options.concurrency, signal: signal },
    );
    for (const result of scheduled) {
      if (result.status === "not-run") continue;
      results.push({ gate: result.gate, status: result.status });
      if (result.check) checks.push({ ...result.check, status: result.status });
      else {
        const logFile = path.join(evidenceRun.output, `${plan.indexOf(result.gate)}-failed.log`);
        await writeFile(
          logFile,
          `Verification failed: ${result.error?.message ?? "interrupted"}\n`,
          { flag: "wx" },
        );
        const now = new Date().toISOString();
        checks.push({
          name: result.gate,
          status: "failed",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          evidence: [await evidenceReference(root, logFile)],
        });
      }
    }
    if (scheduled.some((result) => result.status !== "passed")) throw new Error("check_failed");
    if (JSON.stringify(await sourceIdentity(root)) !== JSON.stringify(evidenceRun.source))
      throw new Error("source_changed");
    signal.throwIfAborted();
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
  results.sort((a, b) => plan.indexOf(a.gate) - plan.indexOf(b.gate));
  checks.sort((a, b) => plan.indexOf(a.name) - plan.indexOf(b.name));
  if (options.summary) {
    const directory = path.join(root, "artifacts/pr-verify");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify(
        {
          runId: evidenceRun.runId,
          base: options.base,
          full: options.full,
          template: options.template,
          concurrency: options.concurrency,
          durationMs: Date.now() - Date.parse(evidenceRun.startedAt),
          files,
          results,
          passed: !failure && !signal.aborted,
        },
        null,
        2,
      ) + "\n",
    );
  }
  const indexFile = await writeEvidenceIndex(
    root,
    evidenceRun,
    checks,
    failure || signal.aborted ? "failed" : "passed",
  );
  const status = signal.aborted ? "interrupted" : failure ? "failed" : "passed";
  return commandResult({
    command: "pr:verify",
    runId: evidenceRun.runId,
    status,
    errorCode: failure ? "verification_failed" : null,
    evidence: path.relative(root, indexFile),
    data: { gates: results },
  });
}
export async function failVerificationEvidence(root, result) {
  const indexFile = path.join(root, result.evidence);
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  index.status = "failed";
  await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
  const summaryFile = path.join(root, "artifacts/pr-verify/summary.json");
  const summary = await readFile(summaryFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (summary) {
    const data = JSON.parse(summary);
    if (data.runId === result.runId) {
      data.passed = false;
      await writeFile(summaryFile, JSON.stringify(data, null, 2) + "\n");
    }
  }
}
export async function runVerification(options, { release } = {}) {
  const interruption = new AbortController();
  const interrupt = () => interruption.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let result;
  try {
    try {
      await withVerificationLock(
        root,
        async () => {
          result = await main(options, interruption.signal);
          return result;
        },
        { release },
      );
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      if (result) {
        await failVerificationEvidence(root, result);
        result = { ...result, status: "failed", errorCode: "verification_failed" };
      } else {
        result = commandResult({
          command: "pr:verify",
          status: "failed",
          errorCode: "verification_setup_failed",
        });
      }
    }
    if (interruption.signal.aborted) {
      if (result.evidence) await failVerificationEvidence(root, result);
      result = { ...result, status: "interrupted", errorCode: "verification_failed" };
    }
    printCommandResult(result, options.json);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
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
    runVerification(options).catch((error) => {
      process.stderr.write(`${error.message}\n`);
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
