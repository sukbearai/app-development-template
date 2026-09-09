import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { evidenceReference } from "./verification-evidence.mjs";

export function containerOptions(args, defaultRoot) {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: { source: { type: "string" }, export: { type: "string" } },
  });
  const root = path.resolve(values.source || defaultRoot);
  const output = values.export ? path.resolve(root, values.export) : null;
  if (output) {
    const relative = path.relative(root, output);
    assert.ok(
      relative.startsWith(`artifacts${path.sep}`) && !relative.split(path.sep).includes(".."),
      "Candidate export must be inside artifacts/",
    );
    execFileSync("git", ["check-ignore", "--quiet", relative], { cwd: root });
  }
  return { root, output };
}
export async function prepareCandidateDirectory(output) {
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
}
export async function writeContainerCandidate({
  root,
  output,
  source,
  summaryFile,
  images,
  signal,
}) {
  signal?.throwIfAborted();
  const candidate = {
    schemaVersion: 1,
    source,
    createdAt: new Date().toISOString(),
    images: {},
    verification: await evidenceReference(root, summaryFile),
  };
  for (const role of ["web", "worker"]) {
    candidate.images[role] = {
      id: images[role].id,
      platform: images[role].platform,
      archive: await evidenceReference(root, path.join(output, `${role}.tar`)),
    };
  }
  const file = path.join(output, "candidate.json");
  signal?.throwIfAborted();
  await writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
  return file;
}
