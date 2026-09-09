#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { inside } from "./release-manifest.mjs";

import { deploymentPlan } from "./release-plan.mjs";
export { deploymentPlan, verifyPublishedRelease, verifyTransition } from "./release-plan.mjs";
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

async function main() {
  if (process.argv[2] !== "plan") {
    const { deploymentMain } = await import("./deployment-cli.mjs");
    await deploymentMain();
    return;
  }
  const json = process.argv.includes("--json");
  let options;
  try {
    const args = process.argv.slice(2);
    assert.equal(args.shift(), "plan", "Only the plan command is supported");
    options = parseArgs({
      args,
      options: {
        root: { type: "string", default: process.cwd() },
        manifest: { type: "string" },
        repo: { type: "string" },
        current: { type: "string" },
        rollback: { type: "boolean", default: false },
        json: { type: "boolean" },
      },
      strict: true,
    }).values;
    assert.ok(options.manifest && options.repo, "--manifest and --repo are required");
    repositorySchema.parse(options.repo);
    inside(options.root, options.manifest);
    if (options.current) inside(options.root, options.current);
    assert.ok(!options.rollback || options.current, "--rollback requires --current");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(
      commandResult({ command: "release:plan", status: "invalid", errorCode: "INVALID_ARGUMENT" }),
      json,
    );
    return;
  }
  try {
    const plan = await deploymentPlan(
      options.root,
      inside(options.root, options.manifest),
      options.repo,
      options.current ? inside(options.root, options.current) : null,
      options.rollback,
    );
    if (!json)
      for (const [key, value] of Object.entries(plan.environment))
        process.stdout.write(`${key}=${value}\n`);
    printCommandResult(
      commandResult({
        command: "release:plan",
        status: "passed",
        evidence: options.manifest,
        data: plan,
      }),
      json,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(
      commandResult({
        command: "release:plan",
        status: "failed",
        errorCode: "RELEASE_NOT_DEPLOYABLE",
      }),
      json,
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
