import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishOptions,
  inspectRegistryManifest,
  verifyDraft,
  archiveArguments,
} from "../release-publish.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../verification-evidence.mjs";

test("publication is preview unless apply is explicit and invalid targets are rejected", () => {
  const options = publishOptions([
    "--candidate",
    "candidate.json",
    "--evidence",
    "index.json",
    "--output",
    "artifacts/release",
    "--repo",
    "owner/repo",
  ]);
  assert.notEqual(options.apply, true);
  assert.throws(() => publishOptions(["--apply"]));
  assert.throws(() =>
    publishOptions([
      "--candidate",
      "c",
      "--evidence",
      "e",
      "--output",
      "../outside",
      "--repo",
      "owner/repo",
    ]),
  );
});
test("registry digest is computed from actual manifest bytes and config must match verified image", () => {
  const id = `sha256:${"a".repeat(64)}`;
  const raw = Buffer.from(
    JSON.stringify({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: id },
    }),
  );
  assert.equal(inspectRegistryManifest(raw, id), `sha256:${sha256(raw)}`);
  assert.throws(() => inspectRegistryManifest(raw, `sha256:${"b".repeat(64)}`), /differs/);
  assert.throws(
    () =>
      inspectRegistryManifest(
        Buffer.from('{"mediaType":"application/vnd.oci.image.index.v1+json"}'),
        id,
      ),
    /single-platform/,
  );
});
test("promotion refuses public releases and mutable or wrong source targets", () => {
  const sha = "a".repeat(40);
  verifyDraft({ draft: true, tag_name: "v1.0.0", target_commitish: sha }, sha, "v1.0.0");
  for (const change of [{ draft: false }, { target_commitish: "main" }, { tag_name: "v2.0.0" }]) {
    assert.throws(() =>
      verifyDraft(
        { draft: true, tag_name: "v1.0.0", target_commitish: sha, ...change },
        sha,
        "v1.0.0",
      ),
    );
  }
});
test("archive bytes survive download-artifact permission normalization", async (t) => {
  assert.ok(archiveArguments("a", "b").includes("--mode=0644"));
  const tool = process.env.PSTACK_GNU_TAR || "tar";
  if (!execFileSync(tool, ["--version"], { encoding: "utf8" }).includes("GNU tar")) {
    t.skip("GNU tar is required; this runs on the release Linux platform");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "release-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "proof.log");
  await writeFile(file, "same evidence\n", { mode: 0o600 });
  await writeFile(path.join(root, "files.txt"), "proof.log\n");
  execFileSync(tool, archiveArguments("first.tar.gz", "files.txt"), { cwd: root });
  await chmod(file, 0o644);
  execFileSync(tool, archiveArguments("second.tar.gz", "files.txt"), { cwd: root });
  assert.deepEqual(
    await readFile(path.join(root, "first.tar.gz")),
    await readFile(path.join(root, "second.tar.gz")),
  );
});
