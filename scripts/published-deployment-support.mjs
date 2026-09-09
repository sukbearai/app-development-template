import assert from "node:assert/strict";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { verifiedDeploymentBundle } from "./deployment-executor.mjs";
import { extractDelivery } from "./release-predecessor.mjs";
import { verifyTransition } from "./release-plan.mjs";
import { verifyReleaseRollback } from "./rollback-proof.mjs";
import { evidenceReference } from "./verification-evidence.mjs";

export function rehearsalOptions(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries(
      ["repo", "previous", "candidate", "output"].map((key) => [key, { type: "string" }]),
    ),
  });
  assert.match(
    values.repo ?? "",
    /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "Repository is required",
  );
  for (const key of ["previous", "candidate"])
    assert.match(
      values[key] ?? "",
      /^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/,
      "An explicit release tag is required",
    );
  assert.notEqual(values.previous, values.candidate, "Two different releases are required");
  assert.ok(values.output, "A fresh output directory is required");
  return { ...values, output: path.resolve(values.output) };
}

export function rehearsalDiagnostic(message, secrets = []) {
  let value = String(message);
  for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, "[redacted]");
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[private key redacted]",
    )
    .replace(
      /^.*(?:password|authorization|private.key|token)\s*[=:].*$/gim,
      "[credential diagnostic redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials redacted]@")
    .slice(-4096);
}

const rehearsalPhase = z
  .enum(["prepared", "migrating", "applying", "checking", "committed", "rolling_back", "failed"])
  .nullable()
  .catch(null);
const rehearsalOperationSchema = z.object({
  phase: rehearsalPhase,
  resumePhase: rehearsalPhase,
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
    .nullable()
    .catch(null),
  restored: z.literal(true).catch(false),
});
export function rehearsalOperation(operation) {
  const parsed = rehearsalOperationSchema.safeParse(operation);
  return parsed.success ? parsed.data : null;
}

export function rehearsalCommand(signal, secrets = []) {
  return async (program, args, { env = process.env, cleanup = false, timeout = 900_000 } = {}) => {
    if (!cleanup) signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const supervised = process.platform === "linux";
      const child = spawn(
        supervised ? "python3" : program,
        supervised
          ? [fileURLToPath(new URL("./rehearsal-process.py", import.meta.url)), program, ...args]
          : args,
        {
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let bytes = 0;
      const chunks = [];
      const errors = [];
      let stopped = false;
      const stop = () => {
        stopped = true;
        if (child.pid)
          try {
            process.kill(supervised ? child.pid : -child.pid, supervised ? "SIGTERM" : "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") reject(new Error("REHEARSAL_PROCESS_STOP_FAILED"));
          }
      };
      const timer = setTimeout(stop, timeout);
      if (!cleanup) signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) stop();
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) stop();
        else errors.push(chunk);
      });
      child.once("error", () => reject(new Error("REHEARSAL_COMMAND_FAILED")));
      child.once("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (code === 0 && !stopped) resolve(Buffer.concat(chunks).toString("utf8").trim());
        else {
          let code = "";
          let operation = null;
          try {
            const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (/^[A-Z][A-Z0-9_]{0,79}$/.test(envelope.errorCode)) code = ` ${envelope.errorCode}`;
            operation = rehearsalOperation(envelope.data?.state?.operation);
          } catch {
            /* Only structured CLI error codes are included from stdout. */
          }
          const diagnostic = rehearsalDiagnostic(Buffer.concat(errors).toString("utf8"), secrets);
          const error = new Error(
            `REHEARSAL_COMMAND_FAILED: ${path.basename(program)}${code}${diagnostic ? `\n${diagnostic}` : ""}`,
          );
          error.operation = operation;
          reject(error);
        }
      });
    });
  };
}

export async function downloadPublishedRelease(repository, tag, directory, command) {
  await mkdir(directory);
  const remote = JSON.parse(
    await command("gh", ["api", `repos/${repository}/releases/tags/${tag}`]),
  );
  assert.equal(remote.draft, false, "Release must be public");
  assert.equal(remote.tag_name, tag);
  for (const name of ["release.json", "delivery-evidence.tar.gz"]) {
    const assets = remote.assets.filter((entry) => entry.name === name);
    assert.equal(assets.length, 1, "Release asset missing or ambiguous");
    await command("gh", [
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      name,
      "--dir",
      directory,
    ]);
    const actual = await evidenceReference(directory, path.join(directory, name));
    assert.equal(`sha256:${actual.sha256}`, assets[0].digest, "Downloaded asset digest mismatch");
    assert.equal(actual.bytes, assets[0].size);
  }
  const root = path.join(directory, "bundle");
  await mkdir(root);
  extractDelivery(path.join(directory, "delivery-evidence.tar.gz"), root);
  const manifestFile = path.join(root, "artifacts/release/release.json");
  assert.deepEqual(
    await readFile(manifestFile),
    await readFile(path.join(directory, "release.json")),
  );
  const verified = await verifiedDeploymentBundle(root, manifestFile, repository);
  assert.equal(`v${verified.release.version}`, tag);
  await rm(path.join(directory, "delivery-evidence.tar.gz"));
  return { root, manifestFile, ...verified };
}

export async function verifyRehearsalPair(previous, candidate) {
  assert.notEqual(
    previous.release.source.gitSha,
    candidate.release.source.gitSha,
    "A successor source revision is required",
  );
  assert.equal(
    previous.release.compatibility.migrationLedgerSha256,
    candidate.release.compatibility.migrationLedgerSha256,
    "This rehearsal requires equal migration ledgers",
  );
  assert.notEqual(
    previous.release.images.web.id,
    candidate.release.images.web.id,
    "A distinct successor Web image is required",
  );
  verifyTransition(previous.release, candidate.release, false);
  verifyTransition(candidate.release, previous.release, true);
  return await verifyReleaseRollback(candidate.root, candidate.release, previous.release);
}

export async function cleanupRehearsal(project, docker) {
  assert.match(project, /^pstack-published-[a-f0-9]{16}$/);
  const errors = [];
  const resources = [
    ["containers", ["ps", "-aq"], ["rm", "--force", "--volumes"]],
    ["volumes", ["volume", "ls", "-q"], ["volume", "rm"]],
    ["networks", ["network", "ls", "-q"], ["network", "rm"]],
  ];
  let quiet = 0;
  for (let attempt = 0; attempt < 10 && quiet < 2; attempt++) {
    let found = false;
    for (const [kind, list, remove] of resources) {
      const args = [...list, "--filter", `label=com.docker.compose.project=${project}`];
      try {
        const ids = (await docker(args, { cleanup: true })).split(/\s+/).filter(Boolean);
        if (ids.length) {
          found = true;
          await docker([...remove, ...ids], { cleanup: true });
        }
        assert.equal(await docker(args, { cleanup: true }), "", "Owned resources remain");
      } catch {
        found = true;
        const message = `Failed to remove owned ${kind}`;
        if (!errors.includes(message)) errors.push(message);
      }
    }
    quiet = found ? 0 : quiet + 1;
    if (quiet < 2) await delay(250);
  }
  if (quiet < 2) errors.push("Owned resource cleanup did not reach a stable empty inventory");
  return errors;
}
