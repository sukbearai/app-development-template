#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { tsImport } from "tsx/esm/api";
import { createBackup, restoreBackup, sha256, verifyBackup } from "./db-backup.mjs";
import { loadEnvironment, postgresUrl } from "./env.mjs";
import {
  captureKafkaRecovery,
  parseKafkaRecovery,
  verifyKafkaCheckpointHistory,
  planKafkaRestore,
  installKafkaRecoveryBinding,
  initializeKafkaRecovery,
} from "./kafka-recovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "packages/server/package.json"));
const keyPattern = /^upload_[a-f0-9-]+$/;
const digestPattern = /^[a-f0-9]{64}$/;
const { booleanString } = await tsImport(
  "../packages/server/src/config-values.ts",
  import.meta.url,
);
async function syncPath(file) {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncFile(file) {
  await syncPath(file);
  await syncPath(path.dirname(file));
}
async function syncAncestors(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    await syncPath(current);
    if (path.dirname(current) === current) break;
  }
}
async function publish(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await syncPath(temporary);
  await rename(temporary, file);
  await syncPath(path.dirname(file));
}

export function parseArguments(argv) {
  const [command, ...args] = argv.filter((arg) => arg !== "--");
  if (!["create", "verify", "restore"].includes(command))
    throw new Error("Expected create, verify, or restore");
  const options = { command, confirm: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (args[i] === "--recover-kafka") {
      options.recoverKafka = true;
      continue;
    }
    if (args[i] === "--data-only") {
      options.dataOnly = true;
      continue;
    }
    if (!["--directory", "--output"].includes(args[i]))
      throw new Error(`Unknown argument: ${args[i]}`);
    const key = args[i].slice(2),
      value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key] = path.resolve(value);
  }
  if (!options[command === "create" ? "output" : "directory"])
    throw new Error("create requires --output; verify/restore require --directory");
  if (command === "restore" && !options.confirm)
    throw new Error("Restore requires --confirm and isolated empty database and storage targets");
  if ((options.recoverKafka || options.dataOnly) && command !== "restore")
    throw new Error("Recovery mode options apply only to restore");
  if (options.recoverKafka && options.dataOnly)
    throw new Error("Choose --recover-kafka or --data-only");
  return options;
}

export async function references(client) {
  const rows = (
    await client.query(`SELECT f.id, f.storage_key AS key, f.size_bytes::text AS bytes,
    f.mime_type AS "contentType", i.id AS "intentId", i.provider, i.storage_location AS location, i.state
    FROM app_file_assets f LEFT JOIN app_upload_intents i ON i.storage_key=f.storage_key ORDER BY f.id`)
  ).rows;
  const seen = new Set();
  for (const row of rows) {
    if (
      !keyPattern.test(row.key) ||
      !["local", "s3"].includes(row.provider) ||
      row.state !== "committed" ||
      !row.location ||
      row.location === "legacy-unbound" ||
      !/^\d+$/.test(row.bytes) ||
      !Number.isSafeInteger(Number(row.bytes)) ||
      seen.has(row.key)
    )
      throw new Error("File has missing, duplicate or unbound committed upload intent");
    seen.add(row.key);
  }
  const orphans = (
    await client.query(`SELECT count(*)::int AS n FROM app_upload_intents i
    LEFT JOIN app_file_assets f ON f.storage_key=i.storage_key WHERE i.state='committed' AND f.id IS NULL`)
  ).rows[0].n;
  if (orphans) throw new Error("Committed upload intent has no file asset");
  return rows;
}

export function storage(env = process.env) {
  let sdk, client;
  const local = env.UPLOAD_STORAGE_DIR ? path.resolve(env.UPLOAD_STORAGE_DIR) : undefined;
  const bucket = env.OBJECT_STORAGE_BUCKET || "app-files";
  const endpoint = env.OBJECT_STORAGE_ENDPOINT;
  function s3() {
    if (!endpoint || !env.OBJECT_STORAGE_ACCESS_KEY || !env.OBJECT_STORAGE_SECRET_KEY)
      throw new Error("Explicit S3 configuration is required");
    sdk ??= require("@aws-sdk/client-s3");
    client ??= new sdk.S3Client({
      endpoint,
      region: env.OBJECT_STORAGE_REGION || "us-east-1",
      forcePathStyle: booleanString.default(true).parse(env.OBJECT_STORAGE_FORCE_PATH_STYLE),
      maxAttempts: 2,
      credentials: {
        accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY,
        secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY,
      },
    });
    return client;
  }
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(120000) });
  return {
    location(provider) {
      if (provider === "local") {
        if (!local) throw new Error("Explicit UPLOAD_STORAGE_DIR is required");
        return local;
      }
      s3();
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash)
        throw new Error("S3 endpoint must not contain credentials, query or fragment");
      return `${endpoint}/${bucket}`;
    },
    async download(row, destination) {
      if (row.provider === "local") {
        const source = path.join(local, row.key);
        if (!(await lstat(source)).isFile())
          throw new Error("Managed object must be a regular file");
        await copyFile(source, destination, 1);
      } else {
        s3();
        const result = await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: row.key }));
        await pipeline(result.Body, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      }
    },
    async assertEmpty(provider) {
      this.location(provider);
      if (provider === "local") {
        try {
          if (!(await lstat(local)).isDirectory() || (await readdir(local)).length)
            throw new Error("Local restore target must be an empty real directory");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } else {
        s3();
        const result = await send(new sdk.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
        if (result.KeyCount || result.Contents?.length || result.IsTruncated)
          throw new Error("S3 restore target bucket must be empty");
      }
    },
    async upload(row, source) {
      if (row.provider === "local") {
        await mkdir(local, { recursive: true });
        await copyFile(source, path.join(local, row.key), 1);
        await syncFile(path.join(local, row.key));
        await syncAncestors(path.dirname(local));
      } else {
        s3();
        const body = createReadStream(source);
        const readFailure = new Promise((_resolve, reject) => body.once("error", reject));
        try {
          await Promise.race([
            readFailure,
            send(
              new sdk.PutObjectCommand({
                Bucket: bucket,
                Key: row.key,
                Body: body,
                ContentLength: Number(row.bytes),
                ContentType: row.contentType,
                IfNoneMatch: "*",
              }),
            ),
          ]);
        } finally {
          body.destroy();
        }
      }
    },
    async verify(row) {
      let stream;
      if (row.provider === "local") stream = createReadStream(path.join(local, row.key));
      else {
        s3();
        stream = (await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: row.key }))).Body;
      }
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of stream) {
        digest.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== Number(row.bytes) || digest.digest("hex") !== row.sha256)
        throw new Error(`Restored object checksum differs: ${row.key}`);
    },
    close() {
      client?.destroy();
    },
  };
}

async function checkObject(file, row) {
  const info = await lstat(file);
  if (!info.isFile() || info.size !== Number(row.bytes) || (await sha256(file)) !== row.sha256)
    throw new Error(`Object checksum or size mismatch: ${row.key}`);
}

export async function createBundle(options) {
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await mkdir(path.join(output, "objects"), { mode: 0o700 });
  const objects = [],
    source = storage();
  try {
    // Broker committed offsets must precede pg_export_snapshot, including its callback.
    const kafkaRecovery = await captureKafkaRecovery();
    await createBackup(
      { output: path.join(output, "database"), id: "database" },
      async (client) => {
        for (const row of await references(client)) {
          if (row.location !== source.location(row.provider))
            throw new Error("Upload intent storage binding differs from configured source");
          const file = path.join(output, "objects", row.key);
          await source.download(row, file);
          await syncFile(file);
          if ((await lstat(file)).size !== Number(row.bytes))
            throw new Error(`Object size differs from database: ${row.key}`);
          objects.push({ ...row, sha256: await sha256(file) });
        }
      },
    );
    await syncFile(path.join(output, "database/database.dump"));
    await syncFile(path.join(output, "database/manifest.json"));
    await verifyKafkaCheckpointHistory(kafkaRecovery);
    const manifest = {
      version: 2,
      format: "pstack-application-bundle",
      createdAt: new Date().toISOString(),
      databaseManifestSha256: await sha256(path.join(output, "database/manifest.json")),
      kafkaRecovery,
      objects,
    };
    await publish(path.join(output, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
    await syncAncestors(path.dirname(output));
    await publish(
      path.join(output, "COMPLETE"),
      (await sha256(path.join(output, "bundle.json"))) + "\n",
    );
    await verifyBundle(output);
    console.log(`Application bundle created: ${output}`);
  } finally {
    source.close();
  }
}

export async function verifyBundle(directory) {
  const digest = (await readFile(path.join(directory, "COMPLETE"), "utf8")).trim();
  if (!digestPattern.test(digest) || digest !== (await sha256(path.join(directory, "bundle.json"))))
    throw new Error("Bundle is incomplete or manifest checksum differs");
  const manifest = JSON.parse(await readFile(path.join(directory, "bundle.json"), "utf8"));
  if (
    ![1, 2].includes(manifest.version) ||
    manifest.format !== "pstack-application-bundle" ||
    !Array.isArray(manifest.objects) ||
    !digestPattern.test(manifest.databaseManifestSha256) ||
    manifest.databaseManifestSha256 !==
      (await sha256(path.join(directory, "database/manifest.json")))
  )
    throw new Error("Invalid bundle manifest or database manifest checksum");
  if (manifest.version === 2) parseKafkaRecovery(manifest.kafkaRecovery);
  const seen = new Set();
  for (const row of manifest.objects) {
    if (
      !keyPattern.test(row.key) ||
      !["local", "s3"].includes(row.provider) ||
      !digestPattern.test(row.sha256) ||
      !/^\d+$/.test(row.bytes) ||
      !Number.isSafeInteger(Number(row.bytes)) ||
      row.state !== "committed" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The backup manifest parser validates identity and media metadata before any restore writes.
      typeof row.id !== "string" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The restore parser validates untrusted manifest identity before writes.
      typeof row.intentId !== "string" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The restore parser validates untrusted manifest media metadata before writes.
      typeof row.contentType !== "string" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Restore requires an explicit string storage binding; missing and legacy-unbound locations fail closed.
      typeof row.location !== "string" ||
      !row.location ||
      row.location === "legacy-unbound" ||
      seen.has(row.key)
    )
      throw new Error("Invalid object manifest entry");
    seen.add(row.key);
    await checkObject(path.join(directory, "objects", row.key), row);
  }
  const actual = await readdir(path.join(directory, "objects"));
  if (actual.length !== seen.size || actual.some((key) => !seen.has(key)))
    throw new Error("Bundle objects differ from manifest");
  await verifyBackup({ file: path.join(directory, "database/database.dump") });
  return manifest;
}

export async function restoreBundle(options) {
  if (!options.confirm) throw new Error("Restore requires --confirm");
  const directory = path.resolve(options.directory),
    manifest = await verifyBundle(directory),
    target = storage();
  const kafkaPlan = planKafkaRestore(manifest, options);
  if (kafkaPlan) await verifyKafkaCheckpointHistory(kafkaPlan.checkpoint);
  const client = new Client({ connectionString: postgresUrl(process.env.DATABASE_URL).href });
  try {
    for (const provider of new Set(manifest.objects.map((row) => row.provider)))
      await target.assertEmpty(provider);
    await restoreBackup(
      { file: path.join(directory, "database/database.dump"), confirm: true },
      async (targetClient) => {
        // Outside the dump schemas: a crash after pg_restore must still block worker startup.
        await targetClient.query("CREATE SCHEMA pstack_restore_guard");
      },
    );
    await client.connect();
    if (kafkaPlan) await installKafkaRecoveryBinding(client, kafkaPlan);
    else if (
      options.dataOnly &&
      manifest.version === 2 &&
      manifest.kafkaRecovery.kind === "checkpoint"
    ) {
      await installKafkaRecoveryBinding(client, {
        checkpoint: manifest.kafkaRecovery,
        transportGroup: "data-only-recovery-disabled",
      });
    }
    await client.query("BEGIN");
    await client.query(
      "LOCK TABLE app_file_assets, app_upload_intents IN SHARE ROW EXCLUSIVE MODE",
    );
    const actual = await references(client);
    const expected = manifest.objects.map(({ sha256: ignored, ...row }) => row);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        "Restored database references differ from bundled objects; discard this isolated target",
      );
    for (const row of manifest.objects) {
      await target.upload(row, path.join(directory, "objects", row.key));
      await target.verify(row);
    }
    for (const row of manifest.objects) {
      const changed = await client.query(
        "UPDATE app_upload_intents SET storage_location=$1 WHERE id=$2 AND state='committed' AND storage_location=$3",
        [target.location(row.provider), row.intentId, row.location],
      );
      if (changed.rowCount !== 1) throw new Error("Committed upload changed during restore");
    }
    await client.query(
      `INSERT INTO app_audit_logs (id,action,target_type,trace_id,metadata)
      VALUES ($1,'backup.restore','application',$1,$2)`,
      [
        `restore_${randomUUID()}`,
        JSON.stringify({
          bundleSha256: await sha256(path.join(directory, "bundle.json")),
          objects: manifest.objects.length,
          sourceBindings: [...new Set(manifest.objects.map((row) => row.location))],
          noncommittedIntents: "original bindings preserved; requires operator review",
        }),
      ],
    );
    await client.query("COMMIT");
    if (kafkaPlan) {
      await initializeKafkaRecovery(kafkaPlan);
      await client.query("BEGIN");
      const changed = await client.query(
        "UPDATE app_kafka_recovery SET state='ready' WHERE singleton AND state='restoring' AND transport_group=$1",
        [kafkaPlan.transportGroup],
      );
      if (changed.rowCount !== 1)
        throw new Error("Kafka recovery binding changed before completion");
      await client.query("DROP SCHEMA pstack_restore_guard");
      await client.query("COMMIT");
      console.log(
        `Kafka recovery ready; logical group ${kafkaPlan.checkpoint.logicalGroup}, permanent transport group ${kafkaPlan.transportGroup}`,
      );
    } else if (options.dataOnly)
      console.log(
        "Data-only restore: automatic Kafka recovery is unsupported; worker remains blocked by pstack_restore_guard.",
      );
    else await client.query("DROP SCHEMA pstack_restore_guard");
    console.log(
      "Application restored; committed upload bindings remapped. Review noncommitted intents and verify application before opening traffic.",
    );
  } catch (error) {
    throw new Error(
      `Restore incomplete. Keep targets isolated; retry with a new empty database and storage. ${error.message}`,
      { cause: error },
    );
  } finally {
    await client.end();
    target.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  loadEnvironment(root);
  process.umask(0o077);
  const options = parseArguments(argv);
  if (options.command === "create") return createBundle(options);
  if (options.command === "restore") return restoreBundle(options);
  await verifyBundle(options.directory);
  console.log("Bundle manifests, database archive and every object checksum verified");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      `Application backup failed: ${String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL redacted]")}`,
    );
    process.exitCode = 1;
  });
