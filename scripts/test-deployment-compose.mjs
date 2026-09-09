#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dockerCommand, composeTarget } from "./deployment-compose.mjs";
import { executeDeployment } from "./deployment-executor.mjs";
import { sourceIdentity, evidenceReference } from "./verification-evidence.mjs";
import { toolchain } from "./release-security.mjs";
import { verificationDirectory } from "./verification-output.mjs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const source = await sourceIdentity(repositoryRoot);
const outputRoot = verificationDirectory(repositoryRoot, "deployment");
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, "run-"));
const summary = { schemaVersion: 1, source, status: "failed", checks: [], cleanupErrors: [] };

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pstack-deploy-compose-")));
const project = `pstack-deploy-test-${randomUUID().slice(0, 8)}`;
let docker;
let completed = false;
try {
  const context =
    process.env.DOCKER_CONTEXT || (await dockerCommand(["context", "show"], process.env));
  const [contextInfo] = JSON.parse(
    await dockerCommand(["context", "inspect", context], process.env),
  );
  docker = (args) => dockerCommand(["--context", context, ...args], process.env);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const imageReference = toolchain.images.node;
  await docker(["pull", imageReference]);
  const [image] = JSON.parse(await docker(["image", "inspect", imageReference]));
  const target = {
    schemaVersion: 1,
    id: project,
    project,
    context,
    endpoint: contextInfo.Endpoints.docker.Host,
    repository: "example/disposable-fixture",
    composeFiles: [path.join(root, "compose.json")],
    envFile: path.join(root, ".env"),
    stateDirectory: path.join(root, "state"),
    services: ["web"],
    platform: `${image.Os}/${image.Architecture}`,
    readinessUrl: `http://127.0.0.1:${port}/health`,
    timeoutSeconds: 20,
  };
  const webCode =
    "require('http').createServer((q,r)=>{r.end(JSON.stringify({data:{status:'ok'}}))}).listen(3000,'0.0.0.0')";
  const migrationCode =
    "const fs=require('fs');if(process.argv.includes('db:migrate'))fs.appendFileSync('/proof/migrations','once\\n')";
  await writeFile(target.envFile, "");
  await writeFile(
    target.composeFiles[0],
    JSON.stringify({
      services: {
        migrate: {
          image: "${PSTACK_WEB_IMAGE}",
          entrypoint: ["node", "-e", migrationCode, "--"],
          command: ["pnpm", "--filter", "@pstack/database", "db:migrate"],
          volumes: ["proof:/proof"],
        },
        web: {
          image: "${PSTACK_WEB_IMAGE}",
          command: ["node", "-e", webCode],
          ports: [`127.0.0.1:${port}:3000`],
          healthcheck: {
            test: ["CMD", "node", "-e", "process.exit(0)"],
            interval: "1s",
            timeout: "2s",
            retries: 10,
          },
          volumes: ["proof:/proof"],
        },
      },
      volumes: { proof: {} },
    }),
  );
  const release = {
    version: "1.0.0",
    images: Object.fromEntries(
      ["web", "worker"].map((role) => [
        role,
        { id: image.Id, reference: imageReference, platform: target.platform },
      ]),
    ),
    compatibility: {
      migrationLedgerSha256: "a".repeat(64),
      recoveryProtocol: "pstack-recovery-v2",
      rollbackVersions: [],
    },
  };
  const manifestFile = path.join(root, "release.json");
  await writeFile(manifestFile, JSON.stringify(release));
  await writeFile(`${manifestFile}.sigstore.json`, "{}");
  const verify = async (bundleRoot, file) => ({
    release: JSON.parse(await readFile(file, "utf8")),
    manifest: await evidenceReference(bundleRoot, file),
  });
  const result = await executeDeployment({ target, root, manifestFile, verify });
  assert.equal(result.state.operation.phase, "committed");
  const [job] = JSON.parse(await docker(["inspect", result.state.operation.migrationId]));
  assert.equal(job.State.ExitCode, 0);
  assert.equal((await executeDeployment({ target, root, manifestFile, verify })).unchanged, true);
  const runtime = composeTarget(target);
  const [web] = await runtime.observe([release]);
  assert.equal(await docker(["exec", web.Id, "cat", "/proof/migrations"]), "once");
  await docker(["stop", web.Id]);
  assert.equal((await runtime.observe([release]))[0].State.Running, false);
  await runtime.apply(release);
  await runtime.ready(release);
  const operation = result.state.operation;
  await runtime.migration(release, operation, async () => {});
  assert.equal(await docker(["exec", web.Id, "cat", "/proof/migrations"]), "once");
  await docker(["rm", operation.migrationId]);
  await assert.rejects(
    runtime.migration(release, operation, async () => {}),
    /MIGRATION_OUTCOME_UNKNOWN/,
  );
  summary.checks.push(
    "real Compose installs exact images and retains migration evidence",
    "repeated application preserves migration count and volume data",
    "stopped services converge and missing migration jobs fail closed",
  );
  completed = true;
  process.stdout.write(
    "Real disposable Compose passed: initial install, retained migration, exact image, repeated apply, persisted volume and stopped-service convergence. Signature/published release checks use a programmatic fixture.\n",
  );
} catch {
  summary.status = "failed";
} finally {
  for (const [kind, list, remove] of [
    ["containers", ["ps", "-aq"], ["rm", "--force"]],
    ["volumes", ["volume", "ls", "-q"], ["volume", "rm"]],
    ["networks", ["network", "ls", "-q"], ["network", "rm"]],
  ]) {
    try {
      if (!docker) continue;
      const ids = (
        await docker([...list, "--filter", `label=com.docker.compose.project=${project}`])
      )
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) await docker([...remove, ...ids]);
    } catch {
      summary.cleanupErrors.push(`Failed to remove owned ${kind}`);
    }
  }
  await rm(root, { recursive: true, force: true });
  try {
    assert.deepEqual(
      await sourceIdentity(repositoryRoot),
      source,
      "Source changed during deployment verification",
    );
  } catch {
    completed = false;
  }
  summary.status = completed && summary.cleanupErrors.length === 0 ? "passed" : "failed";
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`Deployment evidence: ${output}\n`);
  if (summary.status !== "passed") process.exitCode = 1;
}
