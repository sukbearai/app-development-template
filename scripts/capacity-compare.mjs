#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareCapacity } from "./capacity-comparison.mjs";
import { commandResult, printCommandResult } from "./engineering-command.mjs";

const runId = randomUUID();
const evidence = [];
const interruption = new AbortController();
const interrupt = () => interruption.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let json = process.argv.includes("--json");
let result;
try {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        json: { type: "boolean" },
        baseline: { type: "string", multiple: true },
        candidate: { type: "string", multiple: true },
        rules: { type: "string" },
      },
    }));
    if (!values.baseline?.length || !values.candidate?.length || !values.rules)
      throw new Error("Missing comparison arguments");
  } catch {
    result = {
      status: "invalid",
      errorCode: "CAPACITY_ARGUMENTS_INVALID",
      data: {
        reason:
          "Use --baseline <capacity.json> and --candidate <capacity.json> for each run, --rules <rules.json>, and optionally --json.",
      },
    };
  }
  if (!result) {
    json = values.json === true;
    async function readInput(file, role) {
      const bytes = await readFile(file, { signal: interruption.signal });
      evidence.push({
        role,
        path: path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return JSON.parse(bytes.toString("utf8"));
    }
    const rules = await readInput(values.rules, "rules");
    const groups = [];
    for (const role of ["baseline", "candidate"]) {
      const reports = [];
      for (const file of values[role]) reports.push(await readInput(file, role));
      groups.push(reports);
    }
    interruption.signal.throwIfAborted();
    result = compareCapacity(groups[0], groups[1], rules);
  }
} catch {
  result = interruption.signal.aborted
    ? { status: "interrupted", errorCode: "CAPACITY_INTERRUPTED" }
    : {
        status: "invalid",
        errorCode: "CAPACITY_INPUT_INVALID",
        data: { reason: "A report or rules file could not be read as JSON." },
      };
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (!json && result.data?.reason) process.stderr.write(`${result.data.reason}\n`);
printCommandResult(
  commandResult({ command: "capacity-compare", runId, ...result, evidence }),
  json,
);
