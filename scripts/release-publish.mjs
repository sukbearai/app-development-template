#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { evidenceReference, sha256 } from "./verification-evidence.mjs";
import { createReleaseManifest, verifyCandidateInputs } from "./release-manifest.mjs";
import { readReleaseVersion } from "./release-version-check.mjs";

export function publishOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      candidate: { type: "string" },
      evidence: { type: "string" },
      output: { type: "string" },
      repo: { type: "string" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  assert.ok(
    values.candidate &&
      values.evidence &&
      values.output &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo),
    "candidate, evidence, output and repo required",
  );
  const relative = path.relative(process.cwd(), path.resolve(values.output));
  assert.ok(
    relative.startsWith(`artifacts${path.sep}`),
    "Publish output must be within artifacts/",
  );
  return values;
}
export function inspectRegistryManifest(bytes, expectedId) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.ok(
    [
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].includes(manifest.mediaType),
    "Only verified single-platform image manifests may be published",
  );
  assert.equal(manifest.config?.digest, expectedId, "Registry image differs from tested image");
  return `sha256:${sha256(bytes)}`;
}
function exec(program, args) {
  return execFileSync(program, args, {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function ghJson(endpoint) {
  return JSON.parse(exec("gh", ["api", endpoint]).toString("utf8"));
}
export function archiveArguments(archive, fileList) {
  return [
    "--sort=name",
    "--mtime=UTC 1970-01-01",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=0644",
    "--use-compress-program=gzip -n",
    "-cf",
    archive,
    "-T",
    fileList,
  ];
}
export function verifyDraft(release, sha, tag) {
  assert.equal(release.tag_name, tag, "Wrong release tag");
  assert.equal(release.target_commitish, sha, "Draft source must be a full immutable SHA");
  assert.equal(release.draft, true, "Only a draft may be promoted");
}
async function uploadAsset(repo, release, file, name) {
  const reference = await evidenceReference(process.cwd(), file);
  const current = ghJson(`repos/${repo}/releases/${release.id}`);
  const existing = current.assets.find((asset) => asset.name === name);
  if (existing) {
    assert.equal(
      existing.digest,
      `sha256:${reference.sha256}`,
      "Existing release asset differs; refusing overwrite",
    );
    assert.equal(existing.size, reference.bytes, "Existing release asset size differs");
  } else exec("gh", ["release", "upload", release.tag_name, `${file}#${name}`, "--repo", repo]);
  const uploaded = ghJson(`repos/${repo}/releases/${release.id}`).assets.find(
    (asset) => asset.name === name,
  );
  assert.equal(
    uploaded?.digest,
    `sha256:${reference.sha256}`,
    "Uploaded asset digest does not match",
  );
  assert.equal(uploaded.size, reference.bytes, "Uploaded asset size does not match");
}
export async function publishRelease(options) {
  const root = process.cwd();
  const candidateFile = path.resolve(options.candidate);
  const evidenceFile = path.resolve(options.evidence);
  const { candidate, index } = await verifyCandidateInputs({ root, candidateFile, evidenceFile });
  const { version, channel } = await readReleaseVersion(root, true);
  const tag = `v${version}`;
  if (!options.apply)
    return { status: "passed", data: { version, tag, source: candidate.source, apply: false } };
  const releases = JSON.parse(
    exec("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${options.repo}/releases?per_page=100`,
    ]).toString("utf8"),
  ).flat();
  const matches = releases.filter((item) => item.tag_name === tag);
  assert.equal(matches.length, 1, "Expected exactly one reserved release");
  const release = matches[0];
  const commit = ghJson(`repos/${options.repo}/commits/${tag}`);
  assert.equal(commit.sha, candidate.source.gitSha, "Reserved tag differs from tested source");
  verifyDraft(release, candidate.source.gitSha, tag);
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const receipt = { schemaVersion: 1, source: candidate.source, images: {} };
  for (const role of ["web", "worker"]) {
    const image = candidate.images[role];
    const repository = `ghcr.io/${options.repo.toLowerCase()}-${role}`;
    const reference = `${repository}:${version}`;
    const existing = spawnSync("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    let raw;
    if (existing.status === 0) {
      raw = Buffer.from(existing.stdout);
      inspectRegistryManifest(raw, image.id);
    } else {
      assert.ok(
        !existing.error &&
          /manifest unknown|not found|NAME_UNKNOWN|MANIFEST_UNKNOWN/i.test(existing.stderr) &&
          !/unauthorized|denied|forbidden/i.test(existing.stderr),
        "Cannot establish registry tag absence",
      );
      exec("docker", ["image", "load", "--input", path.resolve(root, image.archive.path)]);
      const actual = exec("docker", ["image", "inspect", "--format", "{{.Id}}", image.id])
        .toString()
        .trim();
      assert.equal(actual, image.id, "Loaded image differs from tested archive");
      exec("docker", ["image", "tag", image.id, reference]);
      exec("docker", ["image", "push", reference]);
      raw = exec("docker", ["buildx", "imagetools", "inspect", reference, "--raw"]);
    }
    const digest = inspectRegistryManifest(raw, image.id);
    const exact = exec("docker", [
      "buildx",
      "imagetools",
      "inspect",
      `${repository}@${digest}`,
      "--raw",
    ]);
    assert.deepEqual(exact, raw, "Registry digest does not address inspected bytes");
    const manifestFile = path.join(output, `${role}-registry.json`);
    await writeFile(manifestFile, raw);
    receipt.images[role] = {
      reference: `${repository}@${digest}`,
      id: image.id,
      platform: image.platform,
      manifest: await evidenceReference(root, manifestFile),
    };
  }
  const receiptFile = path.join(output, "registry.json");
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const manifestFile = path.join(output, "release.json");
  await createReleaseManifest({
    root,
    candidateFile,
    evidenceFile,
    receiptFile,
    outputFile: manifestFile,
  });
  const files = new Set([
    path.relative(root, manifestFile),
    path.relative(root, candidateFile),
    path.relative(root, evidenceFile),
    path.relative(root, receiptFile),
    candidate.verification.path,
    ...Object.values(candidate.images).map((image) => image.archive.path),
    ...Object.values(receipt.images).map((image) => image.manifest.path),
    ...index.checks.flatMap((check) => check.evidence.map((reference) => reference.path)),
  ]);
  const fileList = path.join(output, "evidence-files.txt");
  for (const file of files)
    assert.ok(!file.includes("\n") && !file.startsWith("-"), "Unsafe archive entry");
  await writeFile(fileList, [...files].sort().join("\n") + "\n");
  const archive = path.join(output, "delivery-evidence.tar.gz");
  exec("tar", archiveArguments(archive, fileList));
  await uploadAsset(options.repo, release, manifestFile, "release.json");
  await uploadAsset(options.repo, release, archive, "delivery-evidence.tar.gz");
  const current = ghJson(`repos/${options.repo}/releases/${release.id}`);
  verifyDraft(current, candidate.source.gitSha, tag);
  assert.equal(
    ghJson(`repos/${options.repo}/commits/${tag}`).sha,
    candidate.source.gitSha,
    "Tag moved during publication",
  );
  exec("gh", [
    "api",
    "--method",
    "PATCH",
    `repos/${options.repo}/releases/${release.id}`,
    "-F",
    "draft=false",
    "-F",
    `prerelease=${channel === "rc"}`,
    "-f",
    `make_latest=${channel === "stable" ? "true" : "false"}`,
  ]);
  return {
    status: "passed",
    evidence: path.relative(root, manifestFile),
    data: { version, tag, releaseId: release.id, images: receipt.images },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let options;
  try {
    options = publishOptions(process.argv.slice(2));
  } catch {
    printCommandResult(
      commandResult({
        command: "release:publish",
        status: "invalid",
        errorCode: "invalid_arguments",
      }),
      process.argv.includes("--json"),
    );
  }
  if (options) {
    try {
      printCommandResult(
        commandResult({ command: "release:publish", ...(await publishRelease(options)) }),
        options.json,
      );
    } catch {
      printCommandResult(
        commandResult({
          command: "release:publish",
          status: "failed",
          errorCode: "publication_failed",
        }),
        options.json,
      );
    }
  }
}
