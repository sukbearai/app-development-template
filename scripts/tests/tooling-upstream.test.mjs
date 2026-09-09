import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkToolingUpstream, validateUpstreamSources } from "../check-tooling-upstream.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const newRevision = "a".repeat(40);

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-upstream-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const filename of [
    "tools/upstream-sources.json",
    "tools/anti-slop",
    ".agents/skills/pstack-x-hallmark",
    "scripts/check-tooling-upstream.mjs",
  ]) {
    await mkdir(path.dirname(path.join(cwd, filename)), { recursive: true });
    await cp(path.join(root, filename), path.join(cwd, filename), { recursive: true });
  }
  await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"));
  const metadata = JSON.parse(
    await readFile(path.join(cwd, "tools/upstream-sources.json"), "utf8"),
  );
  return {
    cwd,
    metadata,
    save: () => writeFile(path.join(cwd, "tools/upstream-sources.json"), JSON.stringify(metadata)),
  };
}

async function digest(directory) {
  const hash = createHash("sha256");
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(current, entry.name);
      hash.update(path.relative(directory, filename));
      if (entry.isDirectory()) await visit(filename);
      else if (!entry.isSymbolicLink()) hash.update(await readFile(filename));
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

function github(status = "ahead", counts = [2, 0]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, "error");
    const endpoint = new URL(url).pathname;
    let data;
    if (endpoint.includes("/compare/")) {
      const base = endpoint.split("/compare/")[1].split("...")[0];
      data = { status, base_commit: { sha: base }, ahead_by: counts[0], behind_by: counts[1] };
    } else if (endpoint.includes("/commits/")) {
      assert.ok(url.endsWith("/commits/release%2Fstable"));
      const pins = {
        "anti-slop": "e8c4880471b23ab7f216fba7b27d173a6ef07d4c",
        hallmark: "13ac0ec7e148655948100b6396439e481361d690",
      };
      data = { sha: status === "identical" ? pins[endpoint.split("/")[3]] : newRevision };
    } else data = { default_branch: "release/stable" };
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return { calls, fetchImpl };
}

test("default checks source metadata without network and does not mutate files", async (t) => {
  const f = await fixture(t);
  const before = await digest(f.cwd);
  const report = await checkToolingUpstream({
    cwd: f.cwd,
    fetchImpl: () => assert.fail("offline network request"),
  });
  assert.equal(report.mode, "offline");
  assert.ok(report.ok && report.results.every((result) => result.status === "validated"));
  const output = execFileSync(
    process.execPath,
    [path.join(f.cwd, "scripts/check-tooling-upstream.mjs"), "--json"],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).mode, "offline");
  assert.equal(await digest(f.cwd), before);
});

test("remote compares pinned base to default branch head and reports repository drift only", async (t) => {
  const f = await fixture(t);
  const before = await digest(f.cwd);
  for (const [status, counts, expected] of [
    ["identical", [0, 0], "current"],
    ["ahead", [2, 0], "update-available"],
    ["behind", [0, 2], "ahead"],
    ["diverged", [2, 3], "diverged"],
  ]) {
    const mock = github(status, counts);
    const report = await checkToolingUpstream({
      cwd: f.cwd,
      remote: true,
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(report.ok, true);
    assert.ok(
      report.results.every((result) => result.status === expected && result.scope === "repository"),
    );
    assert.equal(mock.calls.length, 6);
    const pin = f.metadata.tools[0].sources[0].revision;
    assert.ok(
      mock.calls.some((url) =>
        url.endsWith(`/compare/${pin}...${status === "identical" ? pin : newRevision}`),
      ),
    );
    assert.ok(report.results.some((result) => result.mode === "adapted"));
  }
  assert.equal(await digest(f.cwd), before);
});

test("mixed Hallmark revisions retain individual attribution and comparison bases", async (t) => {
  const f = await fixture(t);
  const source = f.metadata.tools[1].sources.find((item) => item.id === "cobalt");
  const filename = path.join(f.cwd, f.metadata.tools[1].localRoot, source.attributionFile);
  await writeFile(
    filename,
    (await readFile(filename, "utf8")).replaceAll(source.revision, newRevision),
  );
  source.revision = newRevision;
  await f.save();
  const mock = github();
  const fetchImpl = async (url, options) =>
    url.endsWith(`/compare/${newRevision}...${newRevision}`)
      ? new Response(
          JSON.stringify({
            status: "identical",
            base_commit: { sha: newRevision },
            ahead_by: 0,
            behind_by: 0,
          }),
        )
      : mock.fetchImpl(url, options);
  const report = await checkToolingUpstream({ cwd: f.cwd, remote: true, fetchImpl });
  assert.equal(report.ok, true);
  assert.equal(mock.calls.filter((url) => url.includes("/compare/")).length, 2);
  assert.equal(report.results.find((item) => item.source === "cobalt").revision, newRevision);
});

test("network, rate limits, missing refs, invalid JSON and invalid comparisons are unavailable", async (t) => {
  const f = await fixture(t);
  const responses = [
    () => {
      throw new Error("private-token-must-not-appear");
    },
    () => new Response("rate limit", { status: 403 }),
    () => new Response("missing", { status: 404 }),
    () => new Response("rate limit", { status: 429 }),
    () => new Response("not json", { status: 200 }),
    () => new Response(JSON.stringify({ default_branch: "main", sha: "invalid" })),
    () => new Response(JSON.stringify({ sha: newRevision })),
  ];
  for (const fetchImpl of responses) {
    const report = await checkToolingUpstream({
      cwd: f.cwd,
      remote: true,
      fetchImpl,
      token: "private-token-must-not-appear",
    });
    assert.equal(report.ok, false);
    assert.ok(report.results.every((result) => result.status === "unavailable"));
    assert.ok(!JSON.stringify(report).includes("private-token-must-not-appear"));
  }
  for (const bad of [
    { status: "identical", ahead_by: 0, behind_by: 0 },
    { status: "ahead", ahead_by: 0, behind_by: 0 },
    { status: "unknown", ahead_by: 1, behind_by: 1 },
    { status: "ahead", ahead_by: -1, behind_by: 0 },
  ]) {
    const mock = github();
    const fetchImpl = async (url, options) => {
      if (!url.includes("/compare/")) return mock.fetchImpl(url, options);
      const comparison = { ...bad };
      if (bad.status !== "identical")
        comparison.base_commit = { sha: url.split("/compare/")[1].split("...")[0] };
      return new Response(JSON.stringify(comparison));
    };
    assert.equal((await checkToolingUpstream({ cwd: f.cwd, remote: true, fetchImpl })).ok, false);
  }
});

test("invalid metadata, source identity, missing paths and attribution drift fail offline", async (t) => {
  for (const mutation of [
    (metadata) => {
      metadata.version = 2;
    },
    (metadata) => {
      metadata.tools[0].repository = "../repository";
    },
    (metadata) => {
      metadata.tools[0].sources[0].revision = "not-a-sha";
    },
    (metadata) => {
      metadata.tools[0].sources[0].revision = newRevision;
    },
    (metadata) => {
      metadata.tools[0].sources[0].localPaths = ["missing"];
    },
    (metadata) => {
      metadata.tools[0].sources[0].attributionFile = "../README.md";
    },
    (metadata) => {
      metadata.tools[1].sources.pop();
    },
  ]) {
    const f = await fixture(t);
    mutation(f.metadata);
    await f.save();
    await assert.rejects(validateUpstreamSources(f.cwd));
  }
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "tools/upstream-sources.json"), "{broken");
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(f.cwd, "scripts/check-tooling-upstream.mjs")], {
        stdio: "pipe",
      }),
    (error) => error.status === 1,
  );
});

test("remote CLI exits nonzero for unavailable results without leaking credentials or writing files", async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.cwd, "unavailable.mjs");
  await writeFile(
    preload,
    'globalThis.fetch = async () => new Response("private-response", {status: 403});',
  );
  const before = await digest(f.cwd);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "--import",
          preload,
          path.join(f.cwd, "scripts/check-tooling-upstream.mjs"),
          "--remote",
          "--json",
        ],
        {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, GITHUB_TOKEN: "private-token" },
        },
      ),
    (error) => {
      assert.equal(error.status, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert.ok(
        report.results.every(
          (result) => result.status === "unavailable" && result.error === "GitHub HTTP 403",
        ),
      );
      assert.ok(!error.stdout.includes("private-"));
      return true;
    },
  );
  assert.equal(await digest(f.cwd), before);
});
