#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "pg";
import { run } from "./process.mjs";
import { sha256 } from "./db-backup.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "packages/server/package.json"));
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const suffix = randomUUID().replaceAll("-", ""), containers = [];
const directory = await mkdtemp(path.join(tmpdir(), "pstack-app-backup-proof-"));
const postgresImage = process.env.BACKUP_TEST_POSTGRES_IMAGE || "postgres:17-bullseye";
const minioImage = process.env.BACKUP_TEST_MINIO_IMAGE || "minio/minio:RELEASE.2025-04-22T22-12-26Z";
let control, s3;
async function start(args, port, env = process.env) {
  const id = (await run("docker", ["run", "--detach", ...args], { env, stdio: ["ignore", "pipe", "inherit"] })).trim();
  containers.push(id);
  const info = JSON.parse(await run("docker", ["inspect", id], { stdio: ["ignore", "pipe", "inherit"] }))[0];
  return info.NetworkSettings.Ports[`${port}/tcp`][0].HostPort;
}
async function retry(fn) {
  for (let i = 0; ; i++) { try { return await fn(); } catch (error) { if (i >= 59) throw error; await new Promise((resolve) => setTimeout(resolve, 500)); } }
}
try {
  const password = randomUUID(), secret = randomUUID();
  const port = await start(["--name", `pstack-app-backup-pg-${suffix}`, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data", "--env", "POSTGRES_USER=app", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=postgres", postgresImage], 5432, { ...process.env, POSTGRES_PASSWORD: password });
  const base = `postgres://app:${password}@localhost:${port}/`;
  control = await retry(async () => { const client = new Client({ connectionString: base + "postgres" }); try { await client.connect(); return client; } catch (error) { await client.end(); throw error; } });
  const minioPort = await start(["--name", `pstack-app-backup-s3-${suffix}`, "--publish", "127.0.0.1::9000", "--tmpfs", "/data", "--env", "MINIO_ROOT_USER=appbackup", "--env", "MINIO_ROOT_PASSWORD", minioImage, "server", "/data"], 9000, { ...process.env, MINIO_ROOT_PASSWORD: secret });
  const endpoint = `http://localhost:${minioPort}`;
  await retry(async () => { if (!(await fetch(`${endpoint}/minio/health/ready`)).ok) throw new Error("S3 not ready"); });
  s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "appbackup", secretAccessKey: secret } });
  const env = { ...process.env, POSTGRES_TOOLS: "docker", POSTGRES_TOOL_IMAGE: postgresImage,
    OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_ACCESS_KEY: "appbackup", OBJECT_STORAGE_SECRET_KEY: secret,
    OBJECT_STORAGE_FORCE_PATH_STYLE: "true", OBJECT_STORAGE_BUCKET: "source", UPLOAD_STORAGE_DIR: path.join(directory, "source-objects") };
  for (const name of ["source", "target", "corrupt", "missing", "binding", "occupied", "occupieds3"]) await control.query(`CREATE DATABASE "${name}"`);
  for (const bucket of ["source", "target", "binding"]) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await mkdir(env.UPLOAD_STORAGE_DIR);
  await run("pnpm", ["db:migrate"], { cwd: root, env: { ...env, DATABASE_URL: base + "source" } });
  const source = new Client({ connectionString: base + "source" }); await source.connect();
  const localBytes = Buffer.from("local object round trip"), s3Bytes = Buffer.from("s3 object round trip");
  const localKey = `upload_${randomUUID()}`, s3Key = `upload_${randomUUID()}`;
  try {
    for (const [key, provider, bytes, location] of [[localKey, "local", localBytes, env.UPLOAD_STORAGE_DIR], [s3Key, "s3", s3Bytes, `${endpoint}/source`]]) {
      await source.query("INSERT INTO app_upload_intents(id,storage_key,provider,storage_location,state) VALUES($1,$1,$2,$3,'committed')", [key, provider, location]);
      await source.query("INSERT INTO app_file_assets(id,file_name,mime_type,size_bytes,storage_key) VALUES($1,$1,'text/plain',$2,$1)", [key, bytes.length]);
    }
    await source.query("INSERT INTO app_upload_intents(id,storage_key,provider,storage_location,state) VALUES('pending','upload_deadbeef','local',$1,'pending')", [env.UPLOAD_STORAGE_DIR]);
  } finally { await source.end(); }
  await writeFile(path.join(env.UPLOAD_STORAGE_DIR, localKey), localBytes);
  await s3.send(new PutObjectCommand({ Bucket: "source", Key: s3Key, Body: s3Bytes }));
  const bundle = path.join(directory, "bundle");
  const command = (args, database, extra = {}) => run(process.execPath, [path.join(root, "scripts/app-backup.mjs"), ...args], { cwd: root, env: { ...env, DATABASE_URL: base + database, ...extra } });
  await command(["create", "--output", bundle], "source");
  await command(["verify", "--directory", bundle], "source");
  const targetDir = path.join(directory, "target-objects");
  await command(["restore", "--directory", bundle, "--confirm"], "target", { UPLOAD_STORAGE_DIR: targetDir, OBJECT_STORAGE_BUCKET: "target" });
  assert.deepEqual(await readFile(path.join(targetDir, localKey)), localBytes);
  assert.deepEqual(Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "target", Key: s3Key }))).Body.transformToByteArray()), s3Bytes);
  const target = new Client({ connectionString: base + "target" }); await target.connect();
  try {
    const rows = (await target.query("SELECT provider,storage_location AS location FROM app_upload_intents WHERE state='committed' ORDER BY provider")).rows;
    assert.deepEqual(rows, [{ provider: "local", location: targetDir }, { provider: "s3", location: `${endpoint}/target` }]);
    assert.equal((await target.query("SELECT storage_location FROM app_upload_intents WHERE id='pending'")).rows[0].storage_location, env.UPLOAD_STORAGE_DIR);
    assert.equal((await target.query("SELECT count(*)::int AS n FROM app_audit_logs WHERE action='backup.restore'")).rows[0].n, 1);
  } finally { await target.end(); }
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "target", { UPLOAD_STORAGE_DIR: path.join(directory, "retry"), OBJECT_STORAGE_BUCKET: "binding" }));
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "occupied", { UPLOAD_STORAGE_DIR: targetDir, OBJECT_STORAGE_BUCKET: "target" }));
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "occupieds3", { UPLOAD_STORAGE_DIR: path.join(directory, "empty-local"), OBJECT_STORAGE_BUCKET: "target" }));
  await assert.rejects(command(["create", "--output", path.join(directory, "wrong-binding")], "source", { UPLOAD_STORAGE_DIR: targetDir }));
  await assert.rejects(readFile(path.join(directory, "wrong-binding", "COMPLETE")));
  await unlink(path.join(env.UPLOAD_STORAGE_DIR, localKey));
  await assert.rejects(command(["create", "--output", path.join(directory, "missing-source")], "source"));
  await assert.rejects(readFile(path.join(directory, "missing-source", "COMPLETE")));
  const objectPath = path.join(bundle, "objects", localKey), original = await readFile(objectPath);
  await writeFile(objectPath, Buffer.alloc(original.length));
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "corrupt"));
  await unlink(objectPath);
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "missing"));
  await writeFile(objectPath, original);
  const manifestFile = path.join(bundle, "bundle.json"), manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.objects[0].id = "different-file-id";
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(path.join(bundle, "COMPLETE"), await sha256(manifestFile) + "\n");
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "binding", { UPLOAD_STORAGE_DIR: path.join(directory, "binding-objects"), OBJECT_STORAGE_BUCKET: "binding" }));
  for (const database of ["corrupt", "missing", "occupied", "occupieds3"]) {
    const check = new Client({ connectionString: base + database }); await check.connect();
    try { assert.equal((await check.query("SELECT to_regclass('public.app_file_assets') IS NULL AS empty")).rows[0].empty, true); } finally { await check.end(); }
  }
  console.log("Application backup proof passed: real PostgreSQL/local/MinIO recovery, binding audit, preserved pending intent, corrupt/missing object and nonempty targets rejected before restore, database reference mismatch rejected");
} finally {
  s3?.destroy(); if (control) await control.end();
  for (const id of containers.reverse()) await run("docker", ["rm", "--force", "--volumes", id], { stdio: "ignore" });
  await rm(directory, { recursive: true, force: true });
}
