import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { executeDeployment, readDeploymentTarget } from "./deployment-executor.mjs";
import { inside } from "./release-manifest.mjs";

export async function deploymentMain() {
  const json = process.argv.includes("--json");
  const action = process.argv[2];
  let options;
  try {
    assert.ok(
      ["apply", "resume", "rollback", "status"].includes(action),
      "Use plan, apply, resume, rollback or status",
    );
    options = parseArgs({
      args: process.argv.slice(3),
      strict: true,
      options: {
        root: { type: "string", default: process.cwd() },
        manifest: { type: "string" },
        target: { type: "string" },
        json: { type: "boolean" },
      },
    }).values;
    assert.ok(options.target, "--target is required");
    assert.ok(action === "status" || options.manifest, "--manifest is required");
    if (options.manifest) inside(options.root, options.manifest);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printCommandResult(
      commandResult({
        command: "release:deploy",
        status: "invalid",
        errorCode: "INVALID_ARGUMENT",
      }),
      json,
    );
    return;
  }
  try {
    const result = await executeDeployment({
      target: await readDeploymentTarget(path.resolve(options.target)),
      root: path.resolve(options.root),
      manifestFile: options.manifest ? inside(path.resolve(options.root), options.manifest) : null,
      action,
    });
    printCommandResult(
      commandResult({
        command: `release:${action}`,
        status: result.failed ? "failed" : "passed",
        errorCode: result.failed ? result.state.operation.errorCode : null,
        data: result,
      }),
      json,
    );
  } catch {
    printCommandResult(
      commandResult({
        command: `release:${action}`,
        status: "failed",
        errorCode: "DEPLOYMENT_REJECTED",
      }),
      json,
    );
  }
}
