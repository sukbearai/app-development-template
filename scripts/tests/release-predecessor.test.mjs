import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evidenceReference } from "../verification-evidence.mjs";
import { extractDelivery, preparePredecessor, selectPredecessor } from "../release-predecessor.mjs";

const gitSha = "a".repeat(40);
const remote = (tag, draft = false) => ({
  id: 1,
  draft,
  tag_name: tag,
  published_at: "2026-09-09T00:00:00Z",
  assets: [],
});
test("predecessor uses strict numeric prerelease ordering and excludes current and drafts", () => {
  assert.equal(
    selectPredecessor(
      [
        remote("v1.9.0"),
        remote("v1.10.0"),
        remote("v2.0.0-rc.10"),
        remote("v2.0.0-rc.11", true),
        remote("v2.0.0"),
        remote("junk"),
        remote("v01.0.0"),
      ],
      "v2.0.0",
    ).tag_name,
    "v2.0.0-rc.10",
  );
  assert.equal(selectPredecessor([remote("v2.0.0"), remote("v1.1.0")], "v1.0.0"), null);
  assert.throws(
    () => selectPredecessor([remote("v1.0.0"), remote("v1.0.0")], "v2.0.0"),
    /Duplicate/,
  );
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pstack-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "artifacts/release"), { recursive: true });
  const release = {
    tag: "v1.0.0",
    source: { gitSha },
    security: { path: "artifacts/release/security.json" },
  };
  const manifest = path.join(source, "artifacts/release/release.json");
  await writeFile(manifest, JSON.stringify(release));
  const archive = path.join(root, "delivery-evidence.tar.gz");
  execFileSync("tar", ["-czf", archive, "artifacts"], { cwd: source });
  const metadata = remote(release.tag);
  for (const [name, file] of [
    ["release.json", manifest],
    ["delivery-evidence.tar.gz", archive],
  ]) {
    const ref = await evidenceReference(root, file);
    metadata.assets.push({ name, digest: `sha256:${ref.sha256}`, size: ref.bytes });
  }
  const stateFile = path.join(root, "gh-state.json");
  const log = path.join(root, "gh-calls.jsonl");
  await writeFile(
    stateFile,
    JSON.stringify({ releases: [metadata], manifest, archive, gitSha, log }),
  );
  const gh = path.join(root, "gh");
  await writeFile(
    gh,
    `#!${process.execPath}
const fs=require('node:fs'); const path=require('node:path');
const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_GH_STATE));const args=process.argv.slice(2);
fs.appendFileSync(state.log,JSON.stringify(args)+'\\n');
if(args[0]==='api') {const endpoint=args.at(-1);process.stdout.write(JSON.stringify([endpoint.endsWith('releases?per_page=100')?state.releases:endpoint.includes('/commits/')?{sha:state.gitSha}:state.releases[0]]));}
else {if(args[0]!=='release'||args[1]!=='download')throw new Error('unexpected gh call');const name=args[args.indexOf('--pattern')+1];fs.copyFileSync(name==='release.json'?state.manifest:state.archive,path.join(args[args.indexOf('--dir')+1],name));}
`,
  );
  await chmod(gh, 0o755);
  const calls = [];
  const dependencies = {
    run: (program, args) =>
      execFileSync(program === "gh" ? gh : program, args, {
        env: { ...process.env, FIXTURE_GH_STATE: stateFile },
        encoding: "buffer",
      }),
    verify: async (file, bundleRoot) => {
      assert.ok(file.startsWith(bundleRoot + path.sep));
      return JSON.parse(await readFile(file, "utf8"));
    },
    verifySecurity: async (bundleRoot, parsed, repo, options) => {
      assert.deepEqual(options, { allowRepositoryRename: true });
      calls.push({ bundleRoot, parsed, repo });
    },
  };
  const options = {
    root,
    repository: "example/pstack",
    tag: "v2.0.0",
    sha: gitSha,
    output: path.join(root, "artifacts/predecessor"),
  };
  return {
    root,
    release,
    manifest,
    archive,
    metadata,
    stateFile,
    log,
    dependencies,
    options,
    calls,
  };
}
test("download verifies asset hashes and retains signed relative paths in an isolated root; retry never downloads", async (t) => {
  const f = await fixture(t);
  const selected = await preparePredecessor(f.options, f.dependencies);
  assert.equal(selected.previous.manifest, "artifacts/release/release.json");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(f.options.output, selected.previous.manifest))),
    f.release,
  );
  assert.equal(f.calls.length, 1);
  const before = await readFile(`${f.options.output}.json`);
  await writeFile(f.log, "");
  await preparePredecessor({ ...f.options, retry: true }, f.dependencies);
  assert.deepEqual(await readFile(`${f.options.output}.json`), before);
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((args) => args[0] === "api"));
  await writeFile(path.join(f.options.output, selected.previous.manifest), "tampered");
  await assert.rejects(
    preparePredecessor({ ...f.options, retry: true }, f.dependencies),
    /changed/,
  );
});
test("first release records none and retry rejects missing original selection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(preparePredecessor({ ...f.options, retry: true }, f.dependencies), {
    code: "ENOENT",
  });
  const state = JSON.parse(await readFile(f.stateFile));
  state.releases = [];
  await writeFile(f.stateFile, JSON.stringify(state));
  assert.equal((await preparePredecessor(f.options, f.dependencies)).previous, null);
  assert.equal(
    (await preparePredecessor({ ...f.options, retry: true }, f.dependencies)).previous,
    null,
  );
  state.releases = [f.metadata];
  await writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(
    preparePredecessor({ ...f.options, retry: true }, f.dependencies),
    /changed/,
  );
});
test("downloaded archive tampering fails before extraction or signing", async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, "corrupt archive");
  await assert.rejects(preparePredecessor(f.options, f.dependencies), /digest mismatch/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(`${f.options.output}.json`), { code: "ENOENT" });
});
for (const type of ["parent", "absolute", "symlink", "hardlink", "duplicate"]) {
  test(`safe extraction rejects ${type} members before writing any files`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pstack-tar-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const archive = path.join(root, "unsafe.tar.gz");
    const output = path.join(root, "out");
    await mkdir(output);
    execFileSync("python3", [
      "-c",
      `import tarfile,io,sys
with tarfile.open(sys.argv[1],"w:gz") as archive:
 good=tarfile.TarInfo("safe");good.size=1;archive.addfile(good,io.BytesIO(b"a"))
 mode=sys.argv[2];entry=tarfile.TarInfo("../escaped" if mode=="parent" else "/absolute" if mode=="absolute" else "safe" if mode=="duplicate" else "link")
 if mode in ("symlink","hardlink"):entry.type=tarfile.SYMTYPE if mode=="symlink" else tarfile.LNKTYPE;entry.linkname="../escaped"
 archive.addfile(entry)
`,
      archive,
      type,
    ]);
    assert.throws(() => extractDelivery(archive, output));
    await assert.rejects(readFile(path.join(output, "safe")), { code: "ENOENT" });
  });
}
