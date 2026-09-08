import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArguments, storage, verifyBundle } from "../app-backup.mjs";
import { parseRetentionArguments } from "../history-prune.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";

const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const { S3Client } = require("@aws-sdk/client-s3");
const { envSchema } = await tsImport("../../packages/server/src/env.ts", import.meta.url);

test("application backup requires paths and restore confirmation before target writes", () => {
  for (const args of [[], ["create"], ["verify"], ["restore", "--directory", "/tmp/a"], ["create", "--output", "--confirm"]]) assert.throws(() => parseArguments(args));
  assert.equal(parseArguments(["restore", "--directory", "/tmp/a", "--confirm"]).confirm, true);
});
test("incomplete bundles fail verification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bundle-test-"));
  try {
    await assert.rejects(verifyBundle(directory));
    await writeFile(path.join(directory, "COMPLETE"), "unverified");
    await assert.rejects(verifyBundle(directory), /incomplete/);
  } finally { await rm(directory, { recursive: true }); }
});
test("storage restoration refuses nonempty local directories", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "storage-test-"));
  const target = storage({ UPLOAD_STORAGE_DIR: directory });
  try {
    await target.assertEmpty("local");
    await writeFile(path.join(directory, "existing"), "preserve me");
    await assert.rejects(target.assertEmpty("local"), /empty/);
    assert.throws(() => storage({}).location("local"), /Explicit/);
  } finally { target.close(); await rm(directory, { recursive: true }); }
});
test("backup rejects invalid S3 addressing configuration before storage access", () => {
  const config = { OBJECT_STORAGE_ENDPOINT: "https://s3.invalid", OBJECT_STORAGE_ACCESS_KEY: "test", OBJECT_STORAGE_SECRET_KEY: "test" };
  for (const value of ["true", "false", "1", "0", undefined]) {
    const target = storage({ ...config, OBJECT_STORAGE_FORCE_PATH_STYLE: value });
    try { assert.equal(target.location("s3"), "https://s3.invalid/app-files"); }
    finally { target.close(); }
  }
  for (const value of ["yes", "", "FALSE"])
    assert.throws(() => storage({ ...config, OBJECT_STORAGE_FORCE_PATH_STYLE: value }).location("s3"));
});
test("backup and application preserve all supported S3 addressing modes", async () => {
  const send = S3Client.prototype.send;
  let addressing;
  S3Client.prototype.send = async function () {
    addressing = this.config.forcePathStyle;
    return { KeyCount: 0 };
  };
  try {
    for (const [value, expected] of [["0", false], ["false", false], ["1", true], ["true", true], [undefined, true]]) {
      const config = { OBJECT_STORAGE_ENDPOINT: "https://s3.invalid", OBJECT_STORAGE_ACCESS_KEY: "test", OBJECT_STORAGE_SECRET_KEY: "test", OBJECT_STORAGE_FORCE_PATH_STYLE: value };
      const target = storage(config);
      try {
        await target.assertEmpty("s3");
        assert.equal(addressing, expected);
        assert.equal(addressing, envSchema.parse(config).OBJECT_STORAGE_FORCE_PATH_STYLE);
      } finally { target.close(); }
    }
  } finally { S3Client.prototype.send = send; }
});
test("retention is dry-run by default with explicit bounded age and batch", () => {
  const options = parseRetentionArguments(["--days", "30"], new Date("2026-09-07T00:00:00Z"));
  assert.equal(options.dryRun, true);
  assert.equal(options.before.toISOString(), "2026-08-08T00:00:00.000Z");
  assert.equal(parseRetentionArguments(["--days", "30", "--apply"]).dryRun, false);
  for (const args of [[], ["--days", "0"], ["--days", "1", "--batch-size", "1001"], ["--days", "1.5"], ["--apply"]]) assert.throws(() => parseRetentionArguments(args));
});

test("blocked upload resolution requires explicit write and remote outcome evidence", async () => {
  const { parseResolveArguments } = await import("../resolve-upload.mjs");
  assert.throws(() => parseResolveArguments(["--id", "intent", "--apply"]));
  assert.throws(() => parseResolveArguments(["--id", "intent", "--confirm-writer-stopped", "--confirm-remote-write-settled"]));
  assert.deepEqual(parseResolveArguments(["--id", "intent", "--apply", "--confirm-writer-stopped", "--confirm-remote-write-settled"]), { id: "intent", evidence: { writerStopped: true, remoteWriteSettled: true } });
});

test("session retention requires separate bounded opt-in and keeps the history age", () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const previous = parseRetentionArguments(['--days', '30'], now);
  assert.equal('sessionBefore' in previous, false);
  assert.equal('sessionDays' in previous, false);
  const options = parseRetentionArguments(['--days', '30', '--session-days', '7'], now);
  assert.equal(options.before.toISOString(), previous.before.toISOString());
  assert.equal(options.sessionBefore.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(options.dryRun, true);
  for (const age of ['0', '-1', '1.5', '36501', 'NaN', '9007199254740992']) assert.throws(() => parseRetentionArguments(['--days', '30', '--session-days', age]));
  assert.throws(() => parseRetentionArguments(['--session-days', '7']));
});
