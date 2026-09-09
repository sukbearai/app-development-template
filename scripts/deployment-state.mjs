import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { acquireProcessLock } from "./process-lock.mjs";
import { evidenceReference, sha256 } from "./verification-evidence.mjs";

const absolute = z.string().refine(path.isAbsolute, "An absolute path is required");
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const legacyTarget = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  project: identifier,
  context: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  endpoint: z.string().startsWith("unix:///"),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  composeFiles: z.array(absolute).min(1),
  envFile: absolute,
  stateDirectory: absolute,
  services: z
    .array(z.enum(["web", "worker"]))
    .min(1)
    .refine((v) => v.includes("web") && new Set(v).size === v.length),
  platform: z.enum(["linux/amd64", "linux/arm64"]),
  readinessUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  }),
  timeoutSeconds: z.number().int().min(10).max(900),
});
export const slotTargetSchema = legacyTarget
  .extend({
    schemaVersion: z.literal(2),
    strategy: z.literal("compose-slots"),
    project: identifier.refine((value) => value.length <= 48),
    network: identifier,
    replicas: z.strictObject({
      web: z.number().int().min(1).max(32),
      worker: z.number().int().min(0).max(32),
    }),
    proxy: z.strictObject({
      image: z.string().regex(/^nginx:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/),
      port: z.number().int().min(1024).max(65535),
      drainSeconds: z.number().int().min(1).max(900),
    }),
  })
  .refine(
    (target) => target.services.includes("worker") === target.replicas.worker > 0,
    "Worker replica count must match services",
  );
export const targetSchema = z.discriminatedUnion("schemaVersion", [legacyTarget, slotTargetSchema]);
const ref = z.strictObject({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
const bundle = z.strictObject({ root: absolute, manifest: ref });
const phase = z.enum([
  "prepared",
  "migrating",
  "applying",
  "checking",
  "rolling_back",
  "committed",
  "failed",
]);
const operation = z.strictObject({
  id: z.string().uuid(),
  phase,
  resumePhase: phase.nullable(),
  desired: bundle,
  previous: bundle.nullable(),
  rollback: z.boolean(),
  migrationName: z.string(),
  migrationId: z.string().nullable(),
  errorCode: z.string().nullable(),
  restored: z.boolean(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const legacyState = z.strictObject({
  schemaVersion: z.literal(1),
  targetHash: z.string(),
  revision: z.number().int().nonnegative(),
  current: bundle.nullable(),
  operation: operation.nullable(),
});
const slot = z.enum(["blue", "green"]);
const active = z.strictObject({ slot, bundle, generation: z.string().uuid() });
const schemaAnchor = z.strictObject({ bundle, ledgerSha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const slotStateSchema = z.strictObject({
  schemaVersion: z.literal(2),
  targetHash: z.string(),
  revision: z.number().int().nonnegative(),
  current: active.nullable(),
  schema: schemaAnchor.nullable(),
  operation: z
    .strictObject({
      id: z.string().uuid(),
      phase: z.enum([
        "prepared",
        "migrating",
        "starting",
        "checking",
        "switching",
        "draining",
        "committed",
        "restoring",
        "failed",
      ]),
      desired: active,
      previous: active.nullable(),
      rollback: z.boolean(),
      migrationName: z.string(),
      migrationId: z.string().nullable(),
      errorCode: z.string().nullable(),
      retryPhase: z
        .enum([
          "prepared",
          "migrating",
          "starting",
          "checking",
          "switching",
          "draining",
          "restoring",
        ])
        .nullable(),
      restored: z.boolean(),
      startedAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
});
export const stateSchema = z.discriminatedUnion("schemaVersion", [legacyState, slotStateSchema]);
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  assert.ok(
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "STATE_DIRECTORY_NOT_PRIVATE",
  );
}
export async function targetIdentity(target) {
  const inputs = [];
  for (const file of [...target.composeFiles, target.envFile]) {
    assert.ok((await lstat(file)).isFile(), "TARGET_INPUT_NOT_REGULAR");
    inputs.push([file, sha256(await readFile(file))]);
  }
  return sha256(JSON.stringify({ target, inputs }));
}
export async function readState(target, identity) {
  const file = path.join(target.stateDirectory, "state.json");
  let state;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("DEPLOYMENT_STATE_CORRUPT", { cause: error });
    try {
      await lstat(path.join(target.stateDirectory, "initialized"));
    } catch (markerError) {
      if (markerError.code !== "ENOENT") throw markerError;
      if (target.schemaVersion === 2)
        return {
          schemaVersion: 2,
          targetHash: identity,
          revision: 0,
          current: null,
          schema: null,
          operation: null,
        };
      return {
        schemaVersion: 1,
        targetHash: identity,
        revision: 0,
        current: null,
        operation: null,
      };
    }
    throw new Error("DEPLOYMENT_STATE_MISSING");
  }
  assert.equal(state.schemaVersion, target.schemaVersion, "STATE_VERSION_MISMATCH");
  assert.equal(state.targetHash, identity, "TARGET_DRIFT");
  return state;
}
export async function saveState(target, state) {
  state.revision++;
  if (state.operation) state.operation.updatedAt = new Date().toISOString();
  await atomicJson(path.join(target.stateDirectory, "initialized"), { schemaVersion: 1 });
  await atomicJson(path.join(target.stateDirectory, "state.json"), stateSchema.parse(state));
  if (state.operation) {
    const receipts = path.join(target.stateDirectory, "operations");
    await privateDirectory(receipts);
    await atomicJson(path.join(receipts, `${state.operation.id}.json`), state.operation);
  }
}
export async function retainBundle(target, root, manifest) {
  const destination = path.join(target.stateDirectory, "bundles", manifest.sha256);
  await privateDirectory(destination);
  const seen = new Set();
  const directories = new Set([destination, path.dirname(destination), target.stateDirectory]);
  async function retain(reference) {
    if (seen.has(reference.path)) return;
    seen.add(reference.path);
    assert.ok(
      !path.isAbsolute(reference.path) && !reference.path.split(/[\\/]/).includes(".."),
      "UNSAFE_BUNDLE_PATH",
    );
    const source = path.join(root, reference.path);
    assert.deepEqual(await evidenceReference(root, source), reference, "BUNDLE_CHANGED");
    const output = path.join(destination, reference.path);
    await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    for (
      let directory = path.dirname(output);
      directory !== target.stateDirectory;
      directory = path.dirname(directory)
    )
      directories.add(directory);
    await copyFile(source, output);
    const copied = await open(output, "r");
    try {
      await copied.sync();
    } finally {
      await copied.close();
    }
    if (source.endsWith(".json")) await visit(JSON.parse(await readFile(source, "utf8")));
  }
  async function visit(value) {
    const reference = ref.safeParse(value);
    if (reference.success) {
      await retain(reference.data);
      return;
    }
    const record = z.record(z.string(), z.json()).safeParse(value);
    const children = record.success
      ? Object.values(record.data)
      : Array.isArray(value)
        ? value
        : [];
    for (const child of children) await visit(child);
  }
  await retain(manifest);
  const signature = `${manifest.path}.sigstore.json`;
  const signatureFile = path.join(destination, signature);
  await copyFile(path.join(root, signature), signatureFile);
  const signatureHandle = await open(signatureFile, "r");
  try {
    await signatureHandle.sync();
  } finally {
    await signatureHandle.close();
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return { root: destination, manifest };
}

export async function deploymentLock(directory) {
  await privateDirectory(directory);
  return acquireProcessLock(path.join(directory, "lock"));
}
