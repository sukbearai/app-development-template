#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeTarget } from "./deployment-compose.mjs";
import { sourceIdentity } from "./verification-evidence.mjs";
import {
  cleanupRehearsal,
  downloadPublishedRelease,
  rehearsalCommand,
  rehearsalDiagnostic,
  rehearsalOptions,
  verifyRehearsalPair,
} from "./published-deployment-support.mjs";
import { createRehearsalTarget } from "./published-deployment-target.mjs";
import {
  rehearsalChecks,
  rehearsalFailureSnapshot,
  untilReady,
} from "./published-deployment-checks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = rehearsalOptions(process.argv.slice(2));
await mkdir(path.dirname(options.output), { recursive: true });
await mkdir(options.output, { mode: 0o700 });
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pstack-published-")));
const project = `pstack-published-${randomBytes(8).toString("hex")}`;
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("REHEARSAL_INTERRUPTED"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const secrets = Object.entries(process.env)
  .filter(([key]) => /TOKEN|PASSWORD|PRIVATE_KEY|SECRET/.test(key))
  .map(([, value]) => value);
const command = rehearsalCommand(abort.signal, secrets);
const docker = (args, settings) => command("docker", ["--context", "default", ...args], settings);
const summary = {
  schemaVersion: 1,
  status: "failed",
  stage: "preflight",
  repository: options.repo,
  previousTag: options.previous,
  candidateTag: options.candidate,
  targetSchemaVersion: 1,
  strategy: "maintenance-window",
  transitions: [],
  cleanupErrors: [],
};
let failureSnapshot;
try {
  assert.equal(process.platform, "linux", "Published rehearsal requires a Linux host");
  summary.source = await sourceIdentity(root);
  assert.equal(summary.source.dirty, false, "Run the rehearsal from a clean source checkout");
  const info = JSON.parse(await docker(["info", "--format", "{{json .}}"]));
  assert.equal(info.OSType, "linux");
  assert.ok(
    ["x86_64", "amd64"].includes(info.Architecture),
    "Published rehearsal requires an amd64 Docker daemon",
  );
  summary.stage = "download_previous";
  const previous = await downloadPublishedRelease(
    options.repo,
    options.previous,
    path.join(directory, "previous"),
    command,
  );
  summary.stage = "download_candidate";
  const candidate = await downloadPublishedRelease(
    options.repo,
    options.candidate,
    path.join(directory, "candidate"),
    command,
  );
  summary.stage = "verify_pair";
  await verifyRehearsalPair(previous, candidate);
  for (const bundle of [previous, candidate])
    for (const role of ["web", "worker"])
      assert.equal(bundle.release.images[role].platform, "linux/amd64");
  summary.releases = [previous, candidate].map(({ release, manifest }) => ({
    version: release.version,
    gitSha: release.source.gitSha,
    manifest,
    images: release.images,
    migrationLedgerSha256: release.compatibility.migrationLedgerSha256,
  }));
  summary.stage = "infrastructure";
  const setup = await createRehearsalTarget(
    directory,
    project,
    options.repo,
    "linux/amd64",
    docker,
    command,
    secrets,
  );
  const runtime = composeTarget(setup.target, (args, env) => command("docker", args, { env }));
  failureSnapshot = () =>
    rehearsalFailureSnapshot(
      setup.target,
      composeTarget(setup.target, (args, env) =>
        command("docker", args, { env, cleanup: true, timeout: 15000 }),
      ),
      [previous.release, candidate.release],
    );
  const checks = rehearsalChecks(setup, runtime, abort.signal);
  await runtime.command(previous.release, ["up", "--detach", "postgres", "kafka", "ingress"]);
  await untilReady(
    async () => (await checks.sql(previous.release, "SELECT 1")) === "1",
    abort.signal,
  );
  const cli = async (action, bundle) => {
    const result = JSON.parse(
      await command(
        process.execPath,
        [
          path.join(root, "scripts/release-deploy.mjs"),
          action,
          "--root",
          bundle.root,
          "--manifest",
          "artifacts/release/release.json",
          "--target",
          setup.targetFile,
          "--json",
        ],
        { env: { ...process.env, NODE_EXTRA_CA_CERTS: setup.caFile } },
      ),
    );
    abort.signal.throwIfAborted();
    assert.equal(result.status, "passed");
    assert.equal(result.data.state.operation.phase, "committed");
    assert.equal(result.data.state.current.manifest.sha256, bundle.manifest.sha256);
    assert.equal(result.data.state.operation.rollback, action === "rollback");
    return result;
  };
  let baseline;
  for (const [stage, action, bundle, create] of [
    ["install_previous", "apply", previous, true],
    ["upgrade_candidate", "apply", candidate, true],
    ["rollback_previous", "rollback", previous, false],
  ]) {
    summary.stage = stage;
    const result = await cli(action, bundle);
    if (stage === "install_previous")
      await runtime.command(bundle.release, [
        "run",
        "--rm",
        "--no-deps",
        "migrate",
        "pnpm",
        "--filter",
        "@pstack/server",
        "admin:bootstrap",
      ]);
    const data = await checks.business(bundle.release, stage, create);
    const migrationRows = await checks.ledger(bundle.release);
    assert.ok(migrationRows.length > 0);
    const infrastructure = await checks.infrastructure();
    if (baseline) {
      assert.deepEqual(
        migrationRows,
        baseline.migrationRows,
        "Migration rows changed during equal-ledger rehearsal",
      );
      assert.deepEqual(
        infrastructure,
        baseline.infrastructure,
        "Infrastructure was replaced during deployment",
      );
    } else baseline = { migrationRows, infrastructure };
    const live = await runtime.observe([bundle.release]);
    assert.ok(
      live.every(
        (container) => container.State.Running && container.State.Health?.Status === "healthy",
      ),
    );
    const receipt = {
      stage,
      action,
      version: bundle.release.version,
      manifest: bundle.manifest,
      operationId: result.data.state.operation.id,
      phase: result.data.state.operation.phase,
      migrationId: result.data.state.operation.migrationId,
      live: live.map((container) => ({
        id: container.Id,
        image: container.Image,
        service: container.Config.Labels["com.docker.compose.service"],
        healthy: true,
      })),
      migrationRows,
      infrastructure,
      business: data,
    };
    summary.transitions.push(receipt);
    await writeFile(
      path.join(options.output, `${stage}.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  }
  summary.stage = "complete";
  assert.deepEqual(await sourceIdentity(root), summary.source, "Source changed during rehearsal");
  summary.status = "passed";
} catch (error) {
  summary.errorCode = abort.signal.aborted
    ? "REHEARSAL_INTERRUPTED"
    : "PUBLISHED_DEPLOYMENT_FAILED";
  summary.diagnostic = rehearsalDiagnostic(error.message, secrets);
  if (error.operation) summary.operation = error.operation;
  if (failureSnapshot && !abort.signal.aborted) summary.failureSnapshot = await failureSnapshot();
} finally {
  summary.cleanupErrors = await cleanupRehearsal(project, docker);
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    summary.cleanupErrors.push("Failed to remove private rehearsal directory");
  }
  if (summary.cleanupErrors.length || abort.signal.aborted) summary.status = "failed";
  await writeFile(
    path.join(options.output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  process.stdout.write(
    `Published deployment rehearsal: ${summary.status}; evidence: ${options.output}\n`,
  );
  if (summary.status !== "passed") process.exitCode = 1;
}
