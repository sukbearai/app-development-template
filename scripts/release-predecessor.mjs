#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evidenceReference } from "./verification-evidence.mjs";
import { inside, verifyRelease } from "./release-manifest.mjs";
import { verifyPublishedRelease } from "./release-plan.mjs";
import { securityExec, verifyReleaseSecurity } from "./release-security.mjs";

function version(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/.exec(tag);
  return match ? match.slice(1).map((value) => (value === undefined ? null : BigInt(value))) : null;
}
function compare(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  if (left[3] === right[3]) return 0;
  if (left[3] === null) return 1;
  if (right[3] === null) return -1;
  return left[3] < right[3] ? -1 : 1;
}
export function selectPredecessor(releases, tag) {
  const current = version(tag);
  assert.ok(current, "Invalid candidate version");
  const eligible = releases.filter(
    (release) =>
      release.draft === false &&
      version(release.tag_name) &&
      compare(version(release.tag_name), current) < 0,
  );
  assert.equal(
    new Set(eligible.map((release) => release.tag_name)).size,
    eligible.length,
    "Duplicate published version",
  );
  eligible.sort((left, right) => compare(version(right.tag_name), version(left.tag_name)));
  return eligible[0] ?? null;
}
const extractProgram = String.raw`
import sys,tarfile,pathlib,shutil
archive,target=sys.argv[1:]
base=pathlib.Path(target)
if base.is_symlink() or not base.is_dir() or any(base.iterdir()): raise ValueError("Extraction target must be an empty directory")
with tarfile.open(archive,"r:gz") as source:
 members=[]; names=set(); total=0
 for member in source:
  name=member.name.rstrip("/")
  parts=name.split("/")
  if any(ord(c)<32 or ord(c)==127 for c in name) or not name or name.startswith("/") or pathlib.PureWindowsPath(name).is_absolute() or "\\" in name or any(p in ("",".","..") for p in parts): raise ValueError("Unsafe archive member path")
  if not (member.isfile() or member.isdir()): raise ValueError("Archive links and special members are forbidden")
  if name in names: raise ValueError("Duplicate archive member")
  names.add(name); members.append(member); total+=member.size
  if len(members)>200000 or total>20*1024*1024*1024: raise ValueError("Archive exceeds extraction limit")
 for member in members:
  destination=base.joinpath(*member.name.rstrip("/").split("/"))
  if member.isdir(): destination.mkdir(parents=True,exist_ok=True)
  else:
   destination.parent.mkdir(parents=True,exist_ok=True)
   with source.extractfile(member) as incoming, destination.open("xb") as outgoing: shutil.copyfileobj(incoming,outgoing)
`;
export function extractDelivery(archive, output, run = securityExec) {
  run("python3", ["-c", extractProgram, archive, output]);
}
function asset(release, name) {
  const matches = release.assets.filter((item) => item.name === name);
  assert.equal(matches.length, 1, `Expected one ${name} asset`);
  assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/, "GitHub asset digest required");
  assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0, "Invalid asset size");
  return matches[0];
}
async function verifyAsset(root, file, expected) {
  const ref = await evidenceReference(root, file);
  assert.equal(`sha256:${ref.sha256}`, expected.digest, "Downloaded asset digest mismatch");
  assert.equal(ref.bytes, expected.size, "Downloaded asset size mismatch");
  return ref;
}
export async function preparePredecessor(options, dependencies = {}) {
  const { root, repository, tag, sha, output, retry = false } = options;
  const run = dependencies.run ?? securityExec;
  const verify = dependencies.verify ?? verifyRelease;
  const verifySecurity = dependencies.verifySecurity ?? verifyReleaseSecurity;
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.ok(version(tag), "Invalid candidate version");
  const outputRelative = path.relative(root, output);
  assert.ok(
    outputRelative.startsWith(`artifacts${path.sep}`),
    "Predecessor output must be under artifacts",
  );
  inside(root, outputRelative);
  const stateFile = `${output}.json`;
  const api = (endpoint) => {
    const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint]).toString());
    return Array.isArray(pages[0]) ? pages.flat() : pages[0];
  };
  let state;
  if (retry) {
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.repository, repository, "Retry repository differs");
    assert.deepEqual(state.candidate, { tag, gitSha: sha }, "Retry candidate differs");
    const selected = selectPredecessor(api(`repos/${repository}/releases?per_page=100`), tag);
    assert.equal(
      selected?.tag_name ?? null,
      state.previous?.tag ?? null,
      "Published predecessor changed since original verification",
    );
    if (state.previous === null) return state;
    assert.equal(state.previous.root, outputRelative, "Retry predecessor root differs");
    await verifyAsset(root, inside(root, state.previous.archive.path), state.previous.archiveAsset);
    await verifyAsset(
      root,
      inside(root, state.previous.downloadedManifest.path),
      state.previous.manifestAsset,
    );
  } else {
    try {
      await readFile(stateFile);
      throw new Error("Predecessor selection exists; use --retry");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const previous = selectPredecessor(api(`repos/${repository}/releases?per_page=100`), tag);
    state = { schemaVersion: 1, repository, candidate: { tag, gitSha: sha }, previous: null };
    await mkdir(path.dirname(output), { recursive: true });
    if (previous) {
      const download = await mkdtemp(`${output}-download-`);
      const staging = await mkdtemp(`${output}-extract-`);
      try {
        const manifestAsset = asset(previous, "release.json");
        const archiveAsset = asset(previous, "delivery-evidence.tar.gz");
        for (const name of ["release.json", "delivery-evidence.tar.gz"])
          run("gh", [
            "release",
            "download",
            previous.tag_name,
            "--repo",
            repository,
            "--pattern",
            name,
            "--dir",
            download,
          ]);
        const downloadedManifest = await verifyAsset(
          root,
          path.join(download, "release.json"),
          manifestAsset,
        );
        const archive = await verifyAsset(
          root,
          path.join(download, "delivery-evidence.tar.gz"),
          archiveAsset,
        );
        extractDelivery(path.join(download, "delivery-evidence.tar.gz"), staging, run);
        const release = JSON.parse(await readFile(path.join(download, "release.json"), "utf8"));
        const manifest = path.posix.join(path.posix.dirname(release.security.path), "release.json");
        const extracted = inside(staging, manifest);
        assert.deepEqual(
          await readFile(extracted),
          await readFile(path.join(download, "release.json")),
          "Archive manifest differs from published asset",
        );
        const parsed = await verify(extracted, staging);
        assert.equal(
          parsed.tag,
          previous.tag_name,
          "Downloaded predecessor tag differs from selected release",
        );
        await verifyPublishedRelease(
          repository,
          parsed,
          await evidenceReference(staging, extracted),
          api,
        );
        await verifySecurity(staging, parsed, repository);
        await rename(staging, output);
        state.previous = {
          root: outputRelative,
          manifest,
          tag: parsed.tag,
          archive,
          archiveAsset,
          downloadedManifest,
          manifestAsset,
        };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        await rm(download, { recursive: true, force: true });
        throw error;
      }
    }
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    return state;
  }
  const manifest = inside(output, state.previous.manifest);
  assert.deepEqual(
    await readFile(manifest),
    await readFile(inside(root, state.previous.downloadedManifest.path)),
    "Retry extracted manifest changed",
  );
  const parsed = await verify(manifest, output);
  assert.equal(parsed.tag, state.previous.tag, "Retry predecessor changed");
  await verifyPublishedRelease(repository, parsed, await evidenceReference(output, manifest), api);
  await verifySecurity(output, parsed, repository);
  return state;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      tag: { type: "string" },
      sha: { type: "string" },
      output: { type: "string" },
      retry: { type: "boolean" },
    },
  });
  const state = await preparePredecessor({
    root: process.cwd(),
    repository: values.repo,
    tag: values.tag,
    sha: values.sha,
    output: path.resolve(values.output),
    retry: values.retry,
  });
  process.stdout.write(`${JSON.stringify(state)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `previous_root=${state.previous?.root ?? ""}\nprevious_manifest=${state.previous?.manifest ?? ""}\n`,
    );
  }
}
