import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { verificationDirectory } from "../verification-output.mjs";

test("gate outputs stay isolated within their own checkout and reject symlink escapes", async (t) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "verify-output-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(verificationDirectory(root, "app", {}), path.join(root, ".verification/app"));
  for (const gate of ["a", "b"])
    assert.equal(
      verificationDirectory(root, "app", { PSTACK_VERIFICATION_ROOT: `.verification/run/${gate}` }),
      path.join(root, `.verification/run/${gate}/app`),
    );
  for (const output of ["../elsewhere", "/tmp/external", ".verification/../../elsewhere"])
    assert.throws(
      () => verificationDirectory(root, "app", { PSTACK_VERIFICATION_ROOT: output }),
      /remain under/,
    );
  assert.throws(() => verificationDirectory(root, "../app", {}), /category/);
  await mkdir(path.join(root, ".verification"));
  await symlink(tmpdir(), path.join(root, ".verification/escape"));
  assert.throws(
    () => verificationDirectory(root, "app", { PSTACK_VERIFICATION_ROOT: ".verification/escape" }),
    /symlinks/,
  );
  await writeFile(path.join(root, ".verification/file"), "not a directory");
  assert.throws(
    () => verificationDirectory(root, "app", { PSTACK_VERIFICATION_ROOT: ".verification/file" }),
    /symlinks or files/,
  );
});
