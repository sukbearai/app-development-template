import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { sourceIdentity } from "../verification-evidence.mjs";
import { releaseFixture } from "./release-fixture.mjs";

const fakeProgram = String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stateFile = process.env.PSTACK_PUBLISH_FIXTURE;
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
appendFileSync(state.log, JSON.stringify({ tool, args }) + '\n');
function result(value) { process.stdout.write(JSON.stringify(value)); }
if (tool === 'gh') {
  if (args[0] === 'release') {
    assert.equal(args[1], 'upload');
    assert.ok(!args.includes('--clobber'));
    const [file, name] = args[3].split('#');
    assert.ok(!state.release.assets.some(asset => asset.name === name));
    if (state.failArchiveOnce && name === 'delivery-evidence.tar.gz') {
      state.failArchiveOnce = false; save(); process.exit(1);
    }
    const bytes = readFileSync(file);
    state.release.assets.push({ name, size: bytes.length, digest: 'sha256:' + (state.corruptReadback ? 'e'.repeat(64) : hash(bytes)) });
    save();
  } else if (args.includes('PATCH')) {
    assert.equal(state.release.assets.length, 2);
    state.release.draft = false; save(); result(state.release);
  } else {
    assert.equal(args[0], 'api');
    const endpoint = args.at(-1);
    assert.ok(!endpoint.includes('/releases/tags/'), 'Draft must be found by listing releases');
    if (endpoint.endsWith('/releases?per_page=100')) {
      assert.deepEqual(args.slice(0, 3), ['api', '--paginate', '--slurp']);
      result([[state.release,...(state.previousRelease?[state.previousRelease]:[])]]);
    } else if (endpoint.includes('/commits/')) result({ sha: state.tagSha });
    else if (endpoint.endsWith('/releases/42')) result(state.release);
    else throw new Error('Unexpected gh endpoint ' + endpoint);
  }
} else if (tool === 'docker') {
  if (args[0] === 'buildx') {
    const ref = args[3];
    const raw = state.registry[ref];
    if (!raw) { process.stderr.write('manifest unknown'); process.exit(1); }
    process.stdout.write(raw);
  } else {
    assert.equal(args[0], 'image');
    if (args[1] === 'inspect') process.stdout.write(args.at(-1));
    else if (args[1] === 'tag') { state.tags[args[3]] = args[2]; save(); }
    else if (args[1] === 'push') {
      const ref = args[2];
      const role = ref.includes('-web:') ? 'web' : 'worker';
      const raw = state.raw[role];
      assert.equal(JSON.parse(raw).config.digest, state.tags[ref]);
      state.registry[ref] = raw;
      state.registry[ref.split(':')[0] + '@sha256:' + hash(raw)] = raw;
      save();
    } else assert.equal(args[1], 'load');
  }
} else {
  assert.equal(tool, 'tar');
  const files = readFileSync(args[args.indexOf('-T') + 1], 'utf8').trim().split('\n');
  const parts = files.map(file => file + '\n' + readFileSync(file).toString('base64'));
  writeFileSync(args[args.indexOf('-cf') + 1], parts.join('\n'));
}
`;

async function publisherFixture(t) {
  const f = await releaseFixture(t);
  const config = JSON.parse(
    await readFile(new URL("../../release-please-config.json", import.meta.url), "utf8"),
  );
  await f.put("release-please-config.json", config);
  await f.put(".release-please-manifest.json", { ".": "0.1.0" });
  const git = (args) => execFileSync("git", args, { cwd: f.root, stdio: "ignore" });
  git(["add", "release-please-config.json", ".release-please-manifest.json"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "release policy",
  ]);
  const source = await sourceIdentity(f.root);
  const summary = JSON.parse(await readFile(path.join(f.root, "artifacts/summary.json"), "utf8"));
  summary.source = source;
  await f.put("artifacts/summary.json", summary);
  f.candidate.source = source;
  f.candidate.verification = await f.ref("artifacts/summary.json");
  f.evidence.source = source;
  f.evidence.checks.find((check) => check.name === "test:containers").evidence = [
    f.candidate.verification,
  ];
  await f.put("artifacts/candidate.json", f.candidate);
  await f.put("artifacts/index.json", f.evidence);
  const bin = path.join(f.root, "artifacts/bin");
  await mkdir(bin);
  for (const tool of ["gh", "docker", "tar"])
    await writeFile(path.join(bin, tool), `#!${process.execPath}\n${fakeProgram}`, { mode: 0o700 });
  const stateFile = path.join(f.root, "artifacts/fixture-state.json");
  const log = path.join(f.root, "artifacts/external-calls.jsonl");
  await writeFile(log, "");
  const state = {
    log,
    tagSha: source.gitSha,
    release: {
      id: 42,
      draft: true,
      tag_name: "v0.1.0",
      target_commitish: source.gitSha,
      assets: [],
    },
    raw: {},
    registry: {},
    tags: {},
  };
  for (const role of ["web", "worker"])
    state.raw[role] = await readFile(path.join(f.root, `artifacts/${role}-manifest.json`), "utf8");
  const save = (next) => writeFile(stateFile, JSON.stringify(next));
  await save(state);
  const readState = async () => JSON.parse(await readFile(stateFile, "utf8"));
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const wrapper = path.join(f.root, "artifacts/publisher-test.mjs");
  await writeFile(
    wrapper,
    `
    import {publishRelease,publishOptions} from ${JSON.stringify(new URL("../release-publish.mjs", import.meta.url).href)};
    import {readFile,writeFile,appendFile} from 'node:fs/promises';
    import path from 'node:path';
    import {evidenceReference} from ${JSON.stringify(new URL("../verification-evidence.mjs", import.meta.url).href)};
    import {securityFixture} from ${JSON.stringify(new URL("./release-fixture.mjs", import.meta.url).href)};
    try {
      const result = await publishRelease(publishOptions(process.argv.slice(2)), {
        scan: async (root,candidate,output) => {
          const destination=path.join(output,'security.json');
          try { await readFile(destination); return await evidenceReference(root,destination); } catch(error) { if(error.code !== 'ENOENT') throw error; }
          const put = async (name,value) => { const file=path.join(root,name); await writeFile(file,JSON.stringify(value)); return file; };
          const ref = (name) => evidenceReference(root,path.join(root,name));
          const source=await securityFixture({candidate,put,ref});
          await writeFile(destination,await readFile(source));
          return evidenceReference(root,destination);
        },
        sign: async (root,release) => {
          const state=JSON.parse(await readFile(process.env.PSTACK_PUBLISH_FIXTURE,'utf8'));
          await appendFile(state.log, JSON.stringify({tool:'security',args:['sign-and-verify']})+'\\n');
          if(state.failSecurity) throw new Error('signature verification rejected');
          const output=path.join(root,'artifacts/published');
          await writeFile(path.join(output,'release.json.sigstore.json'),'fixture bundle');
          for(const role of ['web','worker']) await writeFile(path.join(output,role+'-provenance.json'),'fixture predicate');
        }
      });
      process.stdout.write(JSON.stringify(result));
    } catch(error) { process.stdout.write(JSON.stringify({status:'failed'})); process.stderr.write(error.message); process.exitCode=1; }
  `,
  );
  const run = (apply = true) =>
    spawnSync(
      process.execPath,
      [
        wrapper,
        "--candidate",
        "artifacts/candidate.json",
        "--evidence",
        "artifacts/index.json",
        "--output",
        "artifacts/published",
        "--repo",
        "example/pstack",
        "--json",
        ...(apply ? ["--apply"] : []),
      ],
      {
        cwd: f.root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          PSTACK_PUBLISH_FIXTURE: stateFile,
        },
      },
    );
  return { ...f, run, state, save, readState, calls };
}
function assertResult(result, status) {
  assert.equal(result.status, status === "passed" ? 0 : 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, status);
}
function isWrite(call) {
  return (
    call.tool === "tar" ||
    (call.tool === "gh" && (call.args.includes("PATCH") || call.args[0] === "release")) ||
    (call.tool === "docker" && ["load", "tag", "push"].includes(call.args[1]))
  );
}

test("publisher finds draft by list and reads back both asset digests before promotion", async (t) => {
  const f = await publisherFixture(t);
  assertResult(f.run(), "passed");
  const calls = await f.calls();
  assert.deepEqual(calls[0], {
    tool: "gh",
    args: ["api", "--paginate", "--slurp", "repos/example/pstack/releases?per_page=100"],
  });
  assert.equal(calls.at(-1).args[2], "PATCH");
  for (const asset of ["release.json", "delivery-evidence.tar.gz"]) {
    const upload = calls.findIndex(
      (call) =>
        call.tool === "gh" && call.args[0] === "release" && call.args[3].endsWith(`#${asset}`),
    );
    assert.ok(upload >= 0);
    assert.deepEqual(calls[upload + 1], {
      tool: "gh",
      args: ["api", "repos/example/pstack/releases/42"],
    });
  }
  assert.equal((await f.readState()).release.draft, false);
});
test("security rejection retains draft before any asset upload or promotion", async (t) => {
  const f = await publisherFixture(t);
  await f.save({ ...f.state, failSecurity: true });
  assertResult(f.run(), "failed");
  const calls = await f.calls();
  assert.ok(calls.some((call) => call.tool === "security"));
  assert.ok(
    !calls.some(
      (call) => call.tool === "gh" && (call.args[0] === "release" || call.args.includes("PATCH")),
    ),
  );
  assert.equal((await f.readState()).release.draft, true);
});
test("publisher refuses wrong uploaded asset digest before PATCH", async (t) => {
  const f = await publisherFixture(t);
  await f.save({ ...f.state, corruptReadback: true });
  assertResult(f.run(), "failed");
  assert.ok(!(await f.calls()).some((call) => call.args.includes("PATCH")));
  assert.equal((await f.readState()).release.draft, true);
});
test("partial asset upload retries identical bytes without overwriting images or assets", async (t) => {
  const f = await publisherFixture(t);
  await f.save({ ...f.state, failArchiveOnce: true });
  assertResult(f.run(), "failed");
  const failed = await f.readState();
  assert.equal(failed.release.draft, true);
  assert.deepEqual(
    failed.release.assets.map((asset) => asset.name),
    ["release.json"],
  );
  const firstManifest = await readFile(path.join(f.root, "artifacts/published/release.json"));
  const firstArchive = await readFile(
    path.join(f.root, "artifacts/published/delivery-evidence.tar.gz"),
  );
  const before = (await f.calls()).length;
  assertResult(f.run(), "passed");
  assert.deepEqual(
    await readFile(path.join(f.root, "artifacts/published/release.json")),
    firstManifest,
  );
  assert.deepEqual(
    await readFile(path.join(f.root, "artifacts/published/delivery-evidence.tar.gz")),
    firstArchive,
  );
  const retry = (await f.calls()).slice(before);
  assert.ok(
    !retry.some((call) => call.tool === "docker" && ["load", "tag", "push"].includes(call.args[1])),
  );
  const uploads = retry.filter((call) => call.tool === "gh" && call.args[0] === "release");
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].args[3].endsWith("#delivery-evidence.tar.gz"));
  assert.ok(!retry.some((call) => call.args.includes("--clobber")));
  assert.equal((await f.readState()).release.draft, false);
});
test("moved reserved tag prevents all publication writes", async (t) => {
  const f = await publisherFixture(t);
  await f.save({ ...f.state, tagSha: "f".repeat(40) });
  assertResult(f.run(), "failed");
  assert.ok(!(await f.calls()).some(isWrite));
});
for (const mutation of ["source", "dirty"]) {
  test(`${mutation} mismatch prevents any external tool invocation`, async (t) => {
    const f = await publisherFixture(t);
    if (mutation === "source") {
      f.candidate.source.gitSha = "f".repeat(40);
      await f.put("artifacts/candidate.json", f.candidate);
    } else await f.put("new-source.json", { changed: true });
    assertResult(f.run(), "failed");
    assert.deepEqual(await f.calls(), []);
  });
}
test("default preview invokes no external tools and creates no published release", async (t) => {
  const f = await publisherFixture(t);
  const result = f.run(false);
  assertResult(result, "passed");
  assert.equal(JSON.parse(result.stdout).data.apply, false);
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(readFile(path.join(f.root, "artifacts/published/release.json")), {
    code: "ENOENT",
  });
});

test("published predecessor requires a proof before any publication writes", async (t) => {
  const f = await publisherFixture(t);
  await f.save({ ...f.state, previousRelease: { draft: false, tag_name: "v0.0.9" } });
  assertResult(f.run(), "failed");
  assert.ok(!(await f.calls()).some(isWrite));
});
