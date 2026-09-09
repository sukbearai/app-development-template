import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeDeployment } from "../deployment-executor.mjs";
import { deploymentLock } from "../deployment-state.mjs";
import { evidenceReference } from "../verification-evidence.mjs";

export async function executionFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pstack-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "compose.yml"), "services: {}\n");
  await writeFile(path.join(root, ".env"), "SECRET=private-test-value\n");
  const target = {
    schemaVersion: 1,
    id: "test",
    project: "test",
    context: "default",
    endpoint: "unix:///var/run/docker.sock",
    repository: "example/pstack",
    composeFiles: [path.join(root, "compose.yml")],
    envFile: path.join(root, ".env"),
    stateDirectory: path.join(root, "state"),
    services: ["web", "worker"],
    platform: "linux/arm64",
    readinessUrl: "http://127.0.0.1:1/health",
    timeoutSeconds: 10,
  };
  const images = (letter) =>
    Object.fromEntries(
      ["web", "worker"].map((role) => [
        role,
        {
          id: `sha256:${letter.repeat(64)}`,
          reference: `example/${role}@sha256:${letter.repeat(64)}`,
          platform: target.platform,
        },
      ]),
    );
  const releases = {
    old: {
      version: "1.0.0",
      images: images("a"),
      compatibility: {
        migrationLedgerSha256: "c".repeat(64),
        recoveryProtocol: "pstack-recovery-v2",
        rollbackVersions: [],
      },
    },
    next: {
      version: "1.0.1",
      images: images("b"),
      compatibility: {
        migrationLedgerSha256: "c".repeat(64),
        recoveryProtocol: "pstack-recovery-v2",
        rollbackVersions: ["1.0.0"],
      },
    },
  };
  for (const [key, release] of Object.entries(releases)) {
    await writeFile(path.join(root, `${key}.json`), JSON.stringify(release));
    await writeFile(path.join(root, `${key}.json.sigstore.json`), "{}");
  }
  const verify = async (bundleRoot, file) => ({
    release: JSON.parse(await readFile(file, "utf8")),
    manifest: await evidenceReference(bundleRoot, file),
  });
  const calls = [];
  let live = null;
  let rejectReady = false;
  let lostMigration = false;
  let interrupted = false;
  const runtime = {
    host: async () => "daemon-1",
    model: async () => {},
    observe: async (allowed, required) => {
      if (live)
        assert.ok(
          allowed.some((release) => release.version === live.version),
          "LIVE_IMAGE_DRIFT",
        );
      else assert.ok(!required, "LIVE_SERVICE_COUNT_DRIFT");
      return [];
    },
    pull: async () => {},
    preflight: async () => {},
    stop: async () => {},
    migration: async (release, operation, save) => {
      if (lostMigration) throw new Error("MIGRATION_OUTCOME_UNKNOWN");
      calls.push(`migrate:${release.version}`);
      operation.migrationId = "migration";
      await save();
    },
    apply: async (release) => {
      calls.push(`apply:${release.version}`);
      live = release;
    },
    ready: async (release) => {
      if (interrupted) throw new Error("interruption");
      if (rejectReady && release.version === "1.0.1") throw new Error("READINESS_FAILED");
    },
  };
  const execute = (name = "old", action = "apply") =>
    executeDeployment({
      target,
      root,
      manifestFile: path.join(root, `${name}.json`),
      action,
      verify,
      runtime,
      proof: async () => {},
    });
  return {
    root,
    target,
    releases,
    calls,
    runtime,
    execute,
    rejectReady: () => {
      rejectReady = true;
    },
    loseMigration: () => {
      lostMigration = true;
    },
    interrupt: () => {
      interrupted = true;
    },
    drift: () => {
      live = { version: "unknown" };
    },
  };
}
test("initial deployment and same-ledger upgrade commit private retained state", async (t) => {
  const f = await executionFixture(t);
  assert.equal((await f.execute()).state.operation.phase, "committed");
  assert.equal((await f.execute("next")).state.operation.phase, "committed");
  assert.deepEqual(f.calls, ["migrate:1.0.0", "apply:1.0.0", "migrate:1.0.1", "apply:1.0.1"]);
  assert.equal((await f.execute("next")).unchanged, true);
  assert.ok(
    !(await readFile(path.join(f.target.stateDirectory, "state.json"), "utf8")).includes(
      "private-test-value",
    ),
  );
});
test("failed candidate restores predecessor but retains failed operation", async (t) => {
  const f = await executionFixture(t);
  await f.execute();
  f.rejectReady();
  const result = await f.execute("next");
  assert.equal(result.failed, true);
  assert.equal(result.restored, true);
  assert.equal(result.state.operation.phase, "failed");
  assert.equal(result.state.operation.errorCode, "READINESS_FAILED");
  assert.equal(result.state.current.manifest.path, "old.json");
  assert.equal(f.calls.at(-1), "apply:1.0.0");
});
test("unknown migration outcome blocks retry and a conflicting release", async (t) => {
  const f = await executionFixture(t);
  f.loseMigration();
  assert.equal((await f.execute()).state.operation.errorCode, "MIGRATION_OUTCOME_UNKNOWN");
  await assert.rejects(f.execute("old", "resume"), /INVESTIGATION/);
  await assert.rejects(f.execute("next"), /RESUME/);
});
test("committed image drift, configuration drift and state loss fail closed", async (t) => {
  const f = await executionFixture(t);
  await f.execute();
  f.drift();
  await assert.rejects(f.execute(), /LIVE_IMAGE_DRIFT/);
  await writeFile(f.target.envFile, "SECRET=changed\n");
  await assert.rejects(f.execute(), /TARGET_DRIFT/);
  await rm(path.join(f.target.stateDirectory, "state.json"));
  await assert.rejects(f.execute(), /STATE_MISSING/);
});
test("lock rejects a competing deployment and releases after invocation", async (t) => {
  const f = await executionFixture(t);
  const release = await deploymentLock(f.target.stateDirectory);
  await assert.rejects(f.execute(), /STATE_LOCKED/);
  await release();
  assert.equal((await f.execute()).state.operation.phase, "committed");
});
test("explicit rollback uses saved forward proof and skips migration", async (t) => {
  const f = await executionFixture(t);
  await f.execute();
  await f.execute("next");
  const migrationCount = f.calls.filter((call) => call.startsWith("migrate")).length;
  assert.equal((await f.execute("old", "rollback")).state.operation.phase, "committed");
  assert.equal(f.calls.filter((call) => call.startsWith("migrate")).length, migrationCount);
});

test("a killed owner releases its advisory lock without deleting lock state", async (t) => {
  const { spawn } = await import("node:child_process");
  const f = await executionFixture(t);
  const initial = await deploymentLock(f.target.stateDirectory);
  await initial();
  const moduleUrl = new URL("../process-lock.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {acquireProcessLock} from ${JSON.stringify(moduleUrl)}; await acquireProcessLock(${JSON.stringify(path.join(f.target.stateDirectory, "lock"))}); console.log('locked'); setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });
  await assert.rejects(deploymentLock(f.target.stateDirectory), /STATE_LOCKED/);
  child.kill("SIGKILL");
  await exited;
  const release = await deploymentLock(f.target.stateDirectory);
  await release();
});

test("receipt write failure after commit cannot reset the current release", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const f = await executionFixture(t);
  let receiptFile;
  f.runtime.ready = async () => {
    const state = JSON.parse(
      await readFile(path.join(f.target.stateDirectory, "state.json"), "utf8"),
    );
    receiptFile = path.join(f.target.stateDirectory, "operations", `${state.operation.id}.json`);
    await rm(receiptFile);
    await mkdir(receiptFile);
  };
  await assert.rejects(f.execute(), /STATE_WRITE_FAILED/);
  const state = JSON.parse(
    await readFile(path.join(f.target.stateDirectory, "state.json"), "utf8"),
  );
  assert.equal(state.operation.phase, "committed");
  assert.deepEqual(state.current, state.operation.desired);
  await rm(receiptFile, { recursive: true });
  f.runtime.ready = async () => {};
  assert.equal((await f.execute()).unchanged, true);
});
