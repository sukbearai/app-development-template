#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cosignBinary, securityExec } from "./release-security.mjs";

const binary = await cosignBinary();
const directory = await mkdtemp(path.join(os.tmpdir(), "pstack-cosign-proof-"));
const run = (args) =>
  securityExec(binary, args, {
    cwd: directory,
    env: { ...process.env, COSIGN_PASSWORD: "" },
    timeout: 120000,
  });
try {
  run(["generate-key-pair", "--output-key-prefix", "fixture"]);
  run(["generate-key-pair", "--output-key-prefix", "wrong"]);
  await writeFile(
    path.join(directory, "manifest.json"),
    '{"fixture":"disposable signing proof"}\n',
  );
  run(["sign-blob", "--yes", "--key", "fixture.key", "--bundle", "bundle.json", "manifest.json"]);
  const verify = (key) =>
    run(["verify-blob", "--key", key, "--bundle", "bundle.json", "manifest.json"]);
  verify("fixture.pub");
  assert.throws(() => verify("wrong.pub"));
  const original = await readFile(path.join(directory, "manifest.json"));
  await writeFile(path.join(directory, "manifest.json"), "tampered");
  assert.throws(() => verify("fixture.pub"));
  await writeFile(path.join(directory, "manifest.json"), original);
  verify("fixture.pub");
  process.stdout.write(
    "Real cosign bundle: valid key accepted; wrong key and tampered bytes rejected.\n",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
