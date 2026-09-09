#!/usr/bin/env node
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { dockerCommand, composeTarget } from "./deployment-compose.mjs";
import { executeDeployment } from "./deployment-executor.mjs";
import {
  fixtureVerify,
  fixtureRuntime,
  writeSlotFixture,
} from "./tests/deployment-slot-fixture.mjs";
import { toolchain } from "./toolchain.mjs";
import { sourceIdentity } from "./verification-evidence.mjs";
import { verificationDirectory } from "./verification-output.mjs";
const repository = process.cwd();
const source = await sourceIdentity(repository);
const output = verificationDirectory(repository, "deployment-slots");
await mkdir(output, { recursive: true });
const report = { schemaVersion: 1, source, status: "failed", checks: [], cleanupErrors: [] };

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pstack-slots-")));
const project = `pstack-slots-${randomUUID().slice(0, 8)}`;
const checks = [];
let docker;
let recorder;
let recording = true;
const failures = [];
const samples = [];
const builtImages = [];
let rollbackChild;
let rollbackExit;
const longController = new AbortController();
let longRequest;
let longFinished = false;
try {
  const context =
    process.env.DOCKER_CONTEXT || (await dockerCommand(["context", "show"], process.env));
  docker = async (args) => {
    try {
      return (
        await promisify(execFile)("docker", ["--context", context, ...args], {
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout.trim();
    } catch (error) {
      throw new Error(`fixture docker ${args.join(" ")}: ${error.stderr}`);
    }
  };
  const [contextInfo] = JSON.parse(await docker(["context", "inspect", context]));
  try {
    await docker(["image", "inspect", toolchain.images.node]);
  } catch {
    await docker(["pull", toolchain.images.node]);
  }
  const [image] = JSON.parse(await docker(["image", "inspect", toolchain.images.node]));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const target = {
    schemaVersion: 2,
    strategy: "compose-slots",
    id: project,
    project,
    context,
    endpoint: contextInfo.Endpoints.docker.Host,
    repository: "fixture/slots",
    composeFiles: [path.join(directory, "compose.json")],
    envFile: path.join(directory, ".env"),
    stateDirectory: path.join(directory, "state"),
    services: ["web"],
    platform: `${image.Os}/${image.Architecture}`,
    readinessUrl: `http://127.0.0.1:${port}/api/system/health`,
    timeoutSeconds: 15,
    network: `${project}-shared`,
    replicas: { web: 2, worker: 0 },
    proxy: {
      image: toolchain.images.nginx,
      port,
      drainSeconds: 12,
    },
  };
  await docker(["network", "create", target.network]);
  await docker(["volume", "create", `${project}-data`]);
  const images = {};
  for (const [name, version] of [
    ["old", "1.0.0"],
    ["next", "1.0.1"],
    ["bad", "1.0.2"],
  ]) {
    const file = path.join(directory, `Dockerfile.${name}`);
    await writeFile(
      file,
      `FROM ${toolchain.images.node}\nENV FIXTURE_VERSION=${version} FIXTURE_UNHEALTHY=${name === "bad" ? "1" : "0"}\n`,
    );
    const tag = `${project}-${name}:fixture`;
    await docker(["build", "--quiet", "--tag", tag, "--file", file, directory]);
    builtImages.push(tag);
    const [built] = JSON.parse(await docker(["image", "inspect", tag]));
    images[name] = { Id: built.Id, reference: built.Id };
  }
  assert.equal(new Set(Object.values(images).map((value) => value.Id)).size, 3);
  await writeSlotFixture(directory, target, images);
  const runtime = fixtureRuntime(target);
  for (const [name, invoke] of Object.entries(runtime)) {
    runtime[name] = async (...args) => {
      try {
        return await invoke(...args);
      } catch (error) {
        process.stderr.write(`${name}: ${error.stack}\n`);
        throw error;
      }
    };
  }
  const execute = (name, action = "apply", selected = runtime) =>
    executeDeployment({
      target,
      root: directory,
      manifestFile: path.join(directory, `${name}.json`),
      action,
      runtime: selected,
      verify: fixtureVerify,
      proof: async () => {},
    });
  let result = await execute("old");
  assert.equal(result.state.operation.phase, "committed");
  const proxyId = (
    await docker(["ps", "-q", "--filter", `label=pstack.deployment.target=${project}`])
  ).trim();
  const initialRelease = JSON.parse(await readFile(path.join(directory, "old.json"), "utf8"));
  const canonicalConfig = `${await docker(["exec", proxyId, "cat", "/etc/nginx/pstack.conf"])}\n`;
  const servers = [...canonicalConfig.matchAll(/server ([0-9.]+):3000/g)].map((match) => match[1]);
  const changedConfig = path.join(directory, "tampered.conf");
  await writeFile(
    changedConfig,
    canonicalConfig.replace(`server ${servers[0]}:3000`, `server ${servers[1]}:3000`),
  );
  await docker(["cp", changedConfig, `${proxyId}:/etc/nginx/pstack.conf`]);
  await docker(["exec", proxyId, "nginx", "-s", "reload", "-c", "/etc/nginx/pstack.conf"]);
  await assert.rejects(
    runtime.verifyRoute(result.state.current, initialRelease),
    /PROXY_CONFIGURATION_DRIFT/,
  );
  await writeFile(changedConfig, canonicalConfig);
  await docker(["cp", changedConfig, `${proxyId}:/etc/nginx/pstack.conf`]);
  await docker(["exec", proxyId, "nginx", "-s", "reload", "-c", "/etc/nginx/pstack.conf"]);
  await runtime.verifyRoute(result.state.current, initialRelease);
  checks.push("modified upstream configuration with unchanged generation is rejected");
  recorder = (async () => {
    while (recording) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/write`, {
          signal: AbortSignal.timeout(3000),
          headers: { connection: "close" },
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        samples.push({
          generation: response.headers.get("x-pstack-generation"),
          replica: body.replica,
          version: body.version,
        });
      } catch (error) {
        failures.push(error.message);
      }
      await setTimeout(30);
    }
  })();
  result = await execute("next");
  assert.equal(result.state.current.slot, "green");
  assert.equal(result.state.operation.phase, "committed");
  const green = composeTarget({ ...target, project: `${project}-green` }, dockerCommand, true);
  const release = JSON.parse(await readFile(path.join(directory, "next.json"), "utf8"));
  const containers = await green.observe([release]);
  assert.equal(containers.length, 2);
  assert.equal(await docker(["exec", containers[0].Id, "cat", "/proof/migrations"]), "once");
  checks.push(
    "two exact web replicas and unchanged-ledger rollout preserve data and migration count",
  );
  const bad = await execute("bad");
  assert.equal(bad.restored, true);
  assert.equal(bad.state.current.slot, "green");
  assert.ok(
    samples.some((sample) => sample.version === "1.0.1"),
    "Candidate image version must serve traffic",
  );
  assert.equal(
    new Set(samples.filter((sample) => sample.version === "1.0.1").map((sample) => sample.replica))
      .size,
    2,
  );
  assert.ok(samples.every((sample) => sample.version === "1.0.0" || sample.version === "1.0.1"));
  checks.push(
    "distinct healthy candidate image serves both replicas and unhealthy image preserves predecessor",
  );
  longRequest = fetch(`http://127.0.0.1:${port}/long`, { signal: longController.signal }).then(
    async (response) => {
      assert.equal(response.status, 200);
      const value = await response.json();
      longFinished = true;
      return value;
    },
  );
  longRequest.catch(() => {});
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await docker(["exec", containers[0].Id, "test", "-f", "/proof/long-started"]);
      break;
    } catch {
      await setTimeout(100);
    }
  }
  const targetFile = path.join(directory, "target.json");
  await writeFile(targetFile, JSON.stringify(target));
  const executorUrl = new URL("./deployment-executor.mjs", import.meta.url).href;
  const fixtureUrl = new URL("./tests/deployment-slot-fixture.mjs", import.meta.url).href;
  rollbackChild = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {readFile} from 'node:fs/promises';import{executeDeployment}from ${JSON.stringify(executorUrl)};import{fixtureRuntime,fixtureVerify}from ${JSON.stringify(fixtureUrl)};const target=JSON.parse(await readFile(process.argv[1],'utf8'));await executeDeployment({target,root:process.argv[2],manifestFile:process.argv[2]+'/old.json',action:'rollback',verify:fixtureVerify,runtime:fixtureRuntime(target,'route'),proof:async()=>{}});`,
      targetFile,
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  rollbackChild.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  rollbackExit = new Promise((resolve) =>
    rollbackChild.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const exit = await rollbackExit;
  assert.equal(exit.signal, "SIGKILL", stderr);
  assert.equal(longFinished, false, "Long request must still be active after the route switch");
  const resume = execute("old", "resume");
  resume.catch(() => {});
  const drainDeadline = Date.now() + 15000;
  let draining = false;
  while (Date.now() < drainDeadline) {
    const saved = JSON.parse(
      await readFile(path.join(target.stateDirectory, "state.json"), "utf8"),
    );
    if (saved.operation.phase === "draining") {
      draining = true;
      break;
    }
    await setTimeout(100);
  }
  assert.ok(draining, "Resume must enter draining while old request remains active");
  assert.equal(longFinished, false);
  await docker(["exec", containers[0].Id, "touch", "/proof/release-long"]);
  result = await resume;
  assert.equal(result.state.operation.phase, "committed");
  await longRequest;
  assert.equal((await execute("old")).unchanged, true);
  assert.equal(
    new Set(
      samples
        .filter((sample) => sample.generation === result.state.current.generation)
        .map((sample) => sample.replica),
    ).size,
    2,
  );
  checks.push("process kill after route reload resumes rollback and drains accepted long request");
  const cleanup = fixtureRuntime(target);
  cleanup.remove = async () => {
    throw new Error("CLEANUP_FAILED");
  };
  const incomplete = await execute("next", "apply", cleanup);
  assert.equal(incomplete.state.current.slot, "green");
  assert.equal(incomplete.state.operation.retryPhase, "draining");
  assert.equal((await execute("next", "resume")).state.operation.phase, "committed");
  checks.push("cleanup failure leaves candidate serving and resume completes cleanup");
  recording = false;
  await recorder;
  assert.equal(failures.length, 0, JSON.stringify(failures));
  assert.ok(samples.length > 20);
  assert.equal(
    await docker(["volume", "inspect", `${project}-data`, "--format", "{{.Name}}"]),
    `${project}-data`,
  );
  checks.push(`${samples.length} continuous ingress writes completed without failure`);
  report.status = "passed";
  report.checks = checks;
  report.samples = samples.length;
} finally {
  recording = false;
  longController.abort();
  await longRequest?.catch(() => {});
  await recorder;
  if (rollbackChild && !rollbackChild.exitCode && !rollbackChild.signalCode)
    rollbackChild.kill("SIGKILL");
  await rollbackExit;
  async function cleanup(name, task) {
    try {
      await task();
    } catch {
      report.cleanupErrors.push(name);
    }
  }
  if (docker) {
    for (const owned of [`${project}-blue`, `${project}-green`]) {
      await cleanup(`${owned} containers`, async () => {
        const ids = (
          await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${owned}`])
        )
          .split(/\s+/)
          .filter(Boolean);
        if (ids.length) await docker(["rm", "--force", ...ids]);
      });
    }
    await cleanup("proxy container", async () => {
      const ids = (
        await docker(["ps", "-aq", "--filter", `label=pstack.deployment.target=${project}`])
      )
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) await docker(["rm", "--force", ...ids]);
    });
    await cleanup("shared fixture volume", () => docker(["volume", "rm", `${project}-data`]));
    await cleanup("shared fixture network", () => docker(["network", "rm", `${project}-shared`]));
    for (const tag of builtImages)
      await cleanup(`fixture image ${tag}`, () => docker(["image", "rm", tag]));
  }
  await cleanup("fixture directory", () => rm(directory, { recursive: true, force: true }));
  try {
    assert.deepEqual(
      await sourceIdentity(repository),
      source,
      "SOURCE_CHANGED_DURING_VERIFICATION",
    );
  } catch {
    report.status = "failed";
    report.errorCode = "SOURCE_CHANGED_DURING_VERIFICATION";
  }
  if (report.cleanupErrors.length) report.status = "failed";
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Deployment slot evidence: ${output}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}
