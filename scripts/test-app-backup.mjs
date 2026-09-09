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
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const suffix = randomUUID().replaceAll("-", ""),
  containers = [];
const directory = await mkdtemp(path.join(tmpdir(), "pstack-app-backup-proof-"));
const postgresImage = process.env.BACKUP_TEST_POSTGRES_IMAGE || "postgres:17-bullseye";
const minioImage =
  process.env.BACKUP_TEST_MINIO_IMAGE || "minio/minio:RELEASE.2025-04-22T22-12-26Z";
let control, s3;
async function start(args, port, env = process.env) {
  const id = (
    await run("docker", ["run", "--detach", ...args], { env, stdio: ["ignore", "pipe", "inherit"] })
  ).trim();
  containers.push(id);
  const info = JSON.parse(
    await run("docker", ["inspect", id], { stdio: ["ignore", "pipe", "inherit"] }),
  )[0];
  return info.NetworkSettings.Ports[`${port}/tcp`][0].HostPort;
}
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
async function assertBundleSynced(log, bundle, objectKeys) {
  const events = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const complete = events.findIndex(
    (event) => event.type === "publish" && event.path === path.join(bundle, "COMPLETE"),
  );
  assert.ok(complete >= 0, "COMPLETE must be published");
  const synced = new Set(
    events
      .slice(0, complete)
      .filter((event) => event.type === "sync")
      .map((event) => event.path),
  );
  for (let ancestor = path.dirname(bundle); ; ancestor = path.dirname(ancestor)) {
    assert.ok(synced.has(ancestor), `Ancestor must be synced before COMPLETE: ${ancestor}`);
    if (path.dirname(ancestor) === ancestor) break;
  }
  for (const file of [
    "",
    ...(objectKeys.length ? ["objects"] : []),
    "database",
    "database/database.dump",
    "database/manifest.json",
    "bundle.json.tmp",
    ...objectKeys.map((key) => path.join("objects", key)),
  ]) {
    assert.ok(
      synced.has(path.join(bundle, file)),
      `Bundle content must be synced before COMPLETE: ${file}`,
    );
  }
}
try {
  const password = randomUUID(),
    secret = randomUUID();
  const port = await start(
    [
      "--name",
      `pstack-app-backup-pg-${suffix}`,
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql/data",
      "--env",
      "POSTGRES_USER=app",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=postgres",
      postgresImage,
    ],
    5432,
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  const base = `postgres://app:${password}@localhost:${port}/`;
  control = await retry(async () => {
    const client = new Client({ connectionString: base + "postgres" });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end();
      throw error;
    }
  });
  const minioPort = await start(
    [
      "--name",
      `pstack-app-backup-s3-${suffix}`,
      "--publish",
      "127.0.0.1::9000",
      "--tmpfs",
      "/data",
      "--env",
      "MINIO_ROOT_USER=appbackup",
      "--env",
      "MINIO_ROOT_PASSWORD",
      minioImage,
      "server",
      "/data",
    ],
    9000,
    { ...process.env, MINIO_ROOT_PASSWORD: secret },
  );
  const endpoint = `http://localhost:${minioPort}`;
  await retry(async () => {
    if (!(await fetch(`${endpoint}/minio/health/ready`)).ok) throw new Error("S3 not ready");
  });
  s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "appbackup", secretAccessKey: secret },
  });
  const env = {
    ...process.env,
    POSTGRES_TOOLS: "docker",
    POSTGRES_TOOL_IMAGE: postgresImage,
    KAFKA_BROKERS: "unused.invalid:9092",
    OUTBOX_PUBLISHER: "dry-run",
    KAFKA_CONSUMER_GROUP_ID: "",
    KAFKA_SECURITY_PROTOCOL: "",
    KAFKA_SSL_CA_FILE: "",
    KAFKA_SSL_CERT_FILE: "",
    KAFKA_SSL_KEY_FILE: "",
    KAFKA_SASL_MECHANISM: "",
    KAFKA_SASL_USERNAME: "",
    KAFKA_SASL_PASSWORD: "",
    OBJECT_STORAGE_ENDPOINT: endpoint,
    OBJECT_STORAGE_ACCESS_KEY: "appbackup",
    OBJECT_STORAGE_SECRET_KEY: secret,
    OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    OBJECT_STORAGE_BUCKET: "source",
    UPLOAD_STORAGE_DIR: path.join(directory, "source-objects"),
  };
  for (const name of [
    "source",
    "target",
    "corrupt",
    "missing",
    "binding",
    "occupied",
    "occupieds3",
    "empty",
  ])
    await control.query(`CREATE DATABASE "${name}"`);
  for (const bucket of ["source", "target", "binding"])
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await mkdir(env.UPLOAD_STORAGE_DIR);
  await run("pnpm", ["db:migrate"], { cwd: root, env: { ...env, DATABASE_URL: base + "source" } });
  const source = new Client({ connectionString: base + "source" });
  await source.connect();
  const localBytes = Buffer.from("local object round trip"),
    s3Bytes = Buffer.from("s3 object round trip");
  const localKey = `upload_${randomUUID()}`,
    s3Key = `upload_${randomUUID()}`;
  try {
    for (const [key, provider, bytes, location] of [
      [localKey, "local", localBytes, env.UPLOAD_STORAGE_DIR],
      [s3Key, "s3", s3Bytes, `${endpoint}/source`],
    ]) {
      await source.query(
        "INSERT INTO app_upload_intents(id,storage_key,provider,storage_location,state) VALUES($1,$1,$2,$3,'committed')",
        [key, provider, location],
      );
      await source.query(
        "INSERT INTO app_file_assets(id,file_name,mime_type,size_bytes,storage_key) VALUES($1,$1,'text/plain',$2,$1)",
        [key, bytes.length],
      );
    }
    await source.query(
      "INSERT INTO app_upload_intents(id,storage_key,provider,storage_location,state) VALUES('pending','upload_deadbeef','local',$1,'pending')",
      [env.UPLOAD_STORAGE_DIR],
    );
  } finally {
    await source.end();
  }
  await writeFile(path.join(env.UPLOAD_STORAGE_DIR, localKey), localBytes);
  await s3.send(new PutObjectCommand({ Bucket: "source", Key: s3Key, Body: s3Bytes }));
  const bundle = path.join(directory, "new-parent", "nested-parent", "bundle");
  const command = (args, database, extra = {}, nodeArgs = []) =>
    run(process.execPath, [...nodeArgs, path.join(root, "scripts/app-backup.mjs"), ...args], {
      cwd: root,
      env: { ...env, DATABASE_URL: base + database, ...extra },
    });
  const syncFixture = ["--import", path.join(root, "scripts/tests/fixtures/backup-sync.mjs")];
  const syncLog = path.join(directory, "bundle-sync.jsonl");
  await command(
    ["create", "--output", bundle],
    "source",
    { TEST_BACKUP_SYNC_LOG: syncLog },
    syncFixture,
  );
  await assertBundleSynced(syncLog, bundle, [localKey, s3Key]);
  const failedAncestor = path.join(directory, "failed-parent");
  const failedBundle = path.join(failedAncestor, "nested-parent", "bundle");
  const failedLog = path.join(directory, "failed-sync.jsonl");
  await assert.rejects(
    command(
      ["create", "--output", failedBundle],
      "source",
      {
        TEST_BACKUP_SYNC_LOG: failedLog,
        TEST_BACKUP_SYNC_FAILURE: failedAncestor,
      },
      syncFixture,
    ),
    /failed \(1\)/,
  );
  assert.ok(
    (await readFile(failedLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((event) => event.type === "sync-failure" && event.path === failedAncestor),
  );
  await readFile(path.join(failedBundle, "bundle.json"));
  await assert.rejects(readFile(path.join(failedBundle, "COMPLETE")), { code: "ENOENT" });
  await assert.rejects(command(["verify", "--directory", failedBundle], "source"));
  await run("pnpm", ["db:migrate"], { cwd: root, env: { ...env, DATABASE_URL: base + "empty" } });
  const emptyBundle = path.join(directory, "empty-parent", "nested-parent", "bundle");
  const emptyLog = path.join(directory, "empty-sync.jsonl");
  await command(
    ["create", "--output", emptyBundle],
    "empty",
    { TEST_BACKUP_SYNC_LOG: emptyLog },
    syncFixture,
  );
  await assertBundleSynced(emptyLog, emptyBundle, []);
  console.log(
    "Backup fsync proof passed: nested ancestors synced before COMPLETE for populated and empty bundles; ancestor failure leaves an incomplete bundle",
  );
  await command(["verify", "--directory", bundle], "source");
  const targetDir = path.join(directory, "target-objects");
  await command(["restore", "--directory", bundle, "--confirm"], "target", {
    UPLOAD_STORAGE_DIR: targetDir,
    OBJECT_STORAGE_BUCKET: "target",
  });
  assert.deepEqual(await readFile(path.join(targetDir, localKey)), localBytes);
  assert.deepEqual(
    Buffer.from(
      await (
        await s3.send(new GetObjectCommand({ Bucket: "target", Key: s3Key }))
      ).Body.transformToByteArray(),
    ),
    s3Bytes,
  );
  const target = new Client({ connectionString: base + "target" });
  await target.connect();
  try {
    const rows = (
      await target.query(
        "SELECT provider,storage_location AS location FROM app_upload_intents WHERE state='committed' ORDER BY provider",
      )
    ).rows;
    assert.deepEqual(rows, [
      { provider: "local", location: targetDir },
      { provider: "s3", location: `${endpoint}/target` },
    ]);
    assert.equal(
      (await target.query("SELECT storage_location FROM app_upload_intents WHERE id='pending'"))
        .rows[0].storage_location,
      env.UPLOAD_STORAGE_DIR,
    );
    assert.equal(
      (
        await target.query(
          "SELECT count(*)::int AS n FROM app_audit_logs WHERE action='backup.restore'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await target.end();
  }
  await assert.rejects(
    command(["restore", "--directory", bundle, "--confirm"], "target", {
      UPLOAD_STORAGE_DIR: path.join(directory, "retry"),
      OBJECT_STORAGE_BUCKET: "binding",
    }),
  );
  await assert.rejects(
    command(["restore", "--directory", bundle, "--confirm"], "occupied", {
      UPLOAD_STORAGE_DIR: targetDir,
      OBJECT_STORAGE_BUCKET: "target",
    }),
  );
  await assert.rejects(
    command(["restore", "--directory", bundle, "--confirm"], "occupieds3", {
      UPLOAD_STORAGE_DIR: path.join(directory, "empty-local"),
      OBJECT_STORAGE_BUCKET: "target",
    }),
  );
  await assert.rejects(
    command(["create", "--output", path.join(directory, "wrong-binding")], "source", {
      UPLOAD_STORAGE_DIR: targetDir,
    }),
  );
  await assert.rejects(readFile(path.join(directory, "wrong-binding", "COMPLETE")));
  await unlink(path.join(env.UPLOAD_STORAGE_DIR, localKey));
  await assert.rejects(
    command(["create", "--output", path.join(directory, "missing-source")], "source"),
  );
  await assert.rejects(readFile(path.join(directory, "missing-source", "COMPLETE")));
  const objectPath = path.join(bundle, "objects", localKey),
    original = await readFile(objectPath);
  await writeFile(objectPath, Buffer.alloc(original.length));
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "corrupt"));
  await unlink(objectPath);
  await assert.rejects(command(["restore", "--directory", bundle, "--confirm"], "missing"));
  await writeFile(objectPath, original);
  const manifestFile = path.join(bundle, "bundle.json"),
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.objects[0].id = "different-file-id";
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(path.join(bundle, "COMPLETE"), (await sha256(manifestFile)) + "\n");
  await assert.rejects(
    command(["restore", "--directory", bundle, "--confirm"], "binding", {
      UPLOAD_STORAGE_DIR: path.join(directory, "binding-objects"),
      OBJECT_STORAGE_BUCKET: "binding",
    }),
  );
  for (const database of ["corrupt", "missing", "occupied", "occupieds3"]) {
    const check = new Client({ connectionString: base + database });
    await check.connect();
    try {
      assert.equal(
        (await check.query("SELECT to_regclass('public.app_file_assets') IS NULL AS empty")).rows[0]
          .empty,
        true,
      );
    } finally {
      await check.end();
    }
  }
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { processGenericAsyncMessage } from "./services/worker/src/index.ts";
    import { getPool, closeDatabase } from "./packages/database/src/client.ts";
    import { captureKafkaRecovery } from "./scripts/kafka-recovery.mjs";
    try {
      await processGenericAsyncMessage({ topic: "app.tasks", partition: 0, offset: "0", value: JSON.stringify({
        eventId: "failed-only", eventType: "demo.echo", traceId: "failed-only", payload: {} }) },
        async () => { throw new Error("fixture handler failure"); }, { consumerGroup: "failed-only-group" });
      assert.equal((await getPool().query("SELECT status FROM app_idempotency_keys")).rows[0].status, "failed");
      for (const table of ["app_outbox_events", "app_async_receipts", "app_message_quarantine"])
        assert.equal((await getPool().query("SELECT count(*)::int AS n FROM " + table)).rows[0].n, 0);
      await assert.rejects(captureKafkaRecovery({ ...process.env, KAFKA_BROKERS: "", OUTBOX_PUBLISHER: "dry-run" }), /Existing Kafka activity requires Kafka configuration/);
      await assert.rejects(captureKafkaRecovery({ ...process.env, KAFKA_BROKERS: "unused.invalid:9092", OUTBOX_PUBLISHER: "dry-run", KAFKA_CONSUMER_GROUP_ID: "wrong-group" }), /one logical consumer group/);
      console.log("Failed-task-only backup proof passed: missing brokers and changed logical group rejected before Kafka connection");
    } finally { await closeDatabase(); }
  `,
    ],
    {
      cwd: root,
      env: { ...env, DATABASE_URL: base + "source", APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1" },
    },
  );
  console.log(
    "Application backup proof passed: real PostgreSQL/local/MinIO recovery, binding audit, preserved pending intent, corrupt/missing object and nonempty targets rejected before restore, database reference mismatch rejected",
  );
} finally {
  s3?.destroy();
  if (control) await control.end();
  for (const id of containers.reverse())
    await run("docker", ["rm", "--force", "--volumes", id], { stdio: "ignore" });
  await rm(directory, { recursive: true, force: true });
}
