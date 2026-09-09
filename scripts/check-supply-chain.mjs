#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockedImage } from "./toolchain.mjs";
import { toolchain } from "./toolchain.mjs";

export function checkExecutableReferences(text, file, lock = toolchain) {
  const stages = new Set();
  for (const match of text.matchAll(/\buses:\s*([^\s#]+)/g)) {
    const [action, revision] = match[1].split("@");
    assert.match(revision ?? "", /^[a-f0-9]{40}$/, `Unpinned action in ${file}`);
    assert.equal(revision, lock.actions[action], `Unclassified action in ${file}`);
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:image:|# syntax=|FROM\s+)(.+)/);
    if (!match) continue;
    const value = match[1].trim().replace(/\s+AS\s+.*/i, "");
    const stage = file === "Dockerfile" && /\s+AS\s+([a-z0-9-]+)$/i.exec(match[1])?.[1];
    const internal = stages.has(value);
    if (stage) stages.add(stage);
    if (file === "Dockerfile" && internal) continue;
    if (
      file === "deploy/compose/docker-compose.yml" &&
      /^\$\{COMPOSE_PROJECT_NAME:-pstack-local\}-(?:web|worker):local$/.test(value)
    )
      continue;
    if (
      file === "deploy/compose/release-images.yml" &&
      /^\$\{PSTACK_(?:WEB|WORKER)_IMAGE:\?Use release:plan to obtain a verified digest reference\}$/.test(
        value,
      )
    )
      continue;
    assert.ok(
      Object.values(lock.images).includes(value),
      `Unpinned or unclassified image in ${file}: ${value}`,
    );
  }
  if (file === "Dockerfile") {
    for (const [name, version] of Object.entries(lock.alpinePackages))
      assert.ok(text.includes(`${name}=${version}`), `Missing reviewed Alpine package: ${name}`);
  }
  assert.ok(!/^\s*ARG\s+\w*IMAGE/m.test(text), `Image build overrides are not supported: ${file}`);
}
export async function checkSupplyChain(root) {
  assert.equal(toolchain.schemaVersion, 1);
  for (const ref of Object.values(toolchain.images))
    assert.match(ref, /^[A-Za-z0-9./:-]+@sha256:[a-f0-9]{64}$/);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.packageManager,
    `pnpm@${toolchain.pnpm.version}`,
    "Package manager differs from integrity lock",
  );
  for (const name of [
    "POSTGRES_TOOL_IMAGE",
    "PSTACK_TEST_POSTGRES_IMAGE",
    "BACKUP_TEST_POSTGRES_IMAGE",
    "PSTACK_TEST_KAFKA_SECURITY_IMAGE",
    "PSTACK_TEST_KAFKA_IMAGE",
  ]) {
    if (process.env[name]) lockedImage("postgres", process.env[name]);
  }
  const workflows = (await readdir(path.join(root, ".github/workflows"))).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const files = [
    "Dockerfile",
    ...workflows.map((name) => `.github/workflows/${name}`),
    ...(await readdir(path.join(root, "deploy/compose")))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `deploy/compose/${name}`),
  ];
  for (const file of files)
    checkExecutableReferences(await readFile(path.join(root, file), "utf8"), file);
  for (const name of (await readdir(path.join(root, "scripts"))).filter((name) =>
    name.endsWith(".mjs"),
  )) {
    const source = await readFile(path.join(root, "scripts", name), "utf8");
    for (const match of source.matchAll(
      /["']((?:postgres|apache\/kafka|bitnamilegacy\/kafka|redis|node|otel\/opentelemetry-collector(?:-contrib)?):[0-9][^"']+)["']/g,
    )) {
      assert.ok(
        Object.values(toolchain.images).includes(match[1]),
        `Unpinned executable image in scripts/${name}`,
      );
    }
  }
  return {
    status: "passed",
    images: Object.keys(toolchain.images).length,
    actions: Object.keys(toolchain.actions).length,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await checkSupplyChain(process.cwd()))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
