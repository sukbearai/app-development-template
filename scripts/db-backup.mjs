#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvironment, postgresUrl } from "./env.mjs";
import { run } from "./process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const schemas = ["public", "drizzle"];

export function parseArguments(argv) {
  const [command = "help", ...args] = argv;
  const options = { command };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--confirm") { options.confirm = true; continue; }
    if (!["--file", "--manifest", "--output", "--id"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = value;
  }
  if (!["create", "verify", "restore", "help"].includes(command)) throw new Error("Expected create, verify, restore, or help");
  if (["verify", "restore"].includes(command) && !options.file) throw new Error(`${command} requires --file`);
  if (options.id && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.id)) throw new Error("Invalid backup id");
  return options;
}

export async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export function postgresEnvironment(database) {
  const url = postgresUrl(database);
  const env = { PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)) };
  const parameters = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY",
    connect_timeout: "PGCONNECT_TIMEOUT", application_name: "PGAPPNAME", options: "PGOPTIONS",
    target_session_attrs: "PGTARGETSESSIONATTRS", channel_binding: "PGCHANNELBINDING" };
  for (const [key, value] of url.searchParams) {
    if (!parameters[key]) throw new Error(`Unsupported PostgreSQL URL option: ${key}`);
    env[parameters[key]] = value;
  }
  return env;
}

export function dockerPostgresNetwork(host, platform = process.platform) {
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) return { host, args: [] };
  return platform === "linux"
    ? { host, args: ["--network=host"] }
    : { host: "host.docker.internal", args: ["--add-host=host.docker.internal:host-gateway"] };
}

function dockerBindMount(source, target, readonly = false) {
  return ["type=bind", `source=${source}`, `target=${target}`, ...(readonly ? ["readonly"] : [])]
    .map((field) => /[,"\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(",");
}

async function postgresTool(command, args, database, directories = []) {
  const connection = database ? postgresEnvironment(database) : {};
  const network = dockerPostgresNetwork(connection.PGHOST);
  if (process.env.POSTGRES_TOOLS === "docker" && network.host) connection.PGHOST = network.host;
  const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))), ...connection });
  if (process.env.POSTGRES_TOOLS === "docker") {
    const mounts = [...new Set(directories)].map((dir) => dockerBindMount(dir, dir));
    for (const [key, filename] of [["PGSSLROOTCERT", "sslrootcert"], ["PGSSLCERT", "sslcert"], ["PGSSLKEY", "sslkey"]]) {
      if (!connection[key] || (key === "PGSSLROOTCERT" && connection[key] === "system")) continue;
      const target = `/run/pstack-postgres/${filename}`;
      mounts.push(dockerBindMount(path.resolve(connection[key]), target, true));
      connection[key] = target;
    }
    const user = process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
    const groups = [...new Set(process.getgroups?.() || [])].flatMap((gid) => ["--group-add", String(gid)]);
    return run("docker", ["run", "--rm", ...network.args,
      ...user, ...groups,
      ...Object.keys(connection).flatMap((key) => ["-e", key]),
      ...mounts.flatMap((mount) => ["--mount", mount]),
      process.env.POSTGRES_TOOL_IMAGE || "postgres:17-alpine", command, ...args], { env: environment(), stdio: ["ignore", "pipe", "inherit"] });
  }
  if (process.env.POSTGRES_TOOLS && process.env.POSTGRES_TOOLS !== "local") throw new Error("POSTGRES_TOOLS must be local or docker");
  return run(command, args, { env: environment(), stdio: ["ignore", "pipe", "inherit"] });
}

async function connect(database) {
  postgresEnvironment(database);
  const { Client } = await import("pg");
  const client = new Client({ connectionString: postgresUrl(database).href });
  await client.connect();
  return client;
}

async function ledger(client) {
  const rows = (await client.query('SELECT id, hash, created_at::text FROM drizzle.drizzle_migrations ORDER BY id')).rows;
  if (!rows.length || rows.some((row) => !/^[a-f0-9]{64}$/.test(row.hash))) throw new Error("Database migration ledger is empty or invalid");
  return rows;
}

async function schemaFingerprint(client) {
  const result = await client.query(`SELECT n.nspname AS schema, c.relname AS relation, a.attnum, a.attname,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
    pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY n.nspname,c.relname,a.attnum`, [schemas]);
  const constraints = (await client.query(`SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1) ORDER BY n.nspname,c.relname,con.conname`, [schemas])).rows;
  const indexes = (await client.query('SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=ANY($1) ORDER BY schemaname,tablename,indexname', [schemas])).rows;
  return hash(JSON.stringify({ columns: result.rows, constraints, indexes }));
}

export async function verifyBackup(options) {
  const file = path.resolve(options.file);
  const manifest = JSON.parse(await readFile(options.manifest || path.join(path.dirname(file), "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.format !== "postgres-custom" || manifest.dumpFile !== path.basename(file) ||
      JSON.stringify(manifest.schemas) !== JSON.stringify(schemas) || !/^[a-f0-9]{64}$/.test(manifest.dumpSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(manifest.schemaSha256 || "") || !Array.isArray(manifest.migrations) || !manifest.migrations.length ||
      manifest.ledgerSha256 !== hash(JSON.stringify(manifest.migrations)) ||
      manifest.schemaVersion !== manifest.migrations.at(-1).created_at) throw new Error("Invalid or incomplete backup manifest");
  if ((await stat(file)).size !== manifest.dumpBytes || await sha256(file) !== manifest.dumpSha256) throw new Error("Backup checksum or size mismatch");
  const list = await postgresTool("pg_restore", ["--list", file], undefined, [path.dirname(file)]);
  if (!/TABLE DATA drizzle drizzle_migrations /.test(list) || !/TABLE DATA public /.test(list)) throw new Error("Archive omits application data or migration ledger");
  return { file, manifest, list };
}

export async function createBackup(options, captureSnapshot) {
  const database = postgresUrl(process.env.DATABASE_URL).href;
  const id = options.id || `BKP-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = path.resolve(options.output || path.join(root, "backups", id));
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite an existing backup directory.
  const file = path.join(output, `${id}.dump`);
  const client = await connect(database);
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    if (captureSnapshot) await captureSnapshot(client);
    const migrations = await ledger(client);
    const schemaSha256 = await schemaFingerprint(client);
    const databaseVersion = (await client.query("SHOW server_version")).rows[0].server_version;
    await postgresTool("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--snapshot", snapshot,
      ...schemas.flatMap((schema) => ["--schema", schema]), "--file", file], database, [output]);
    const manifest = { version: 1, id, format: "postgres-custom", schemas, createdAt: new Date().toISOString(), databaseVersion,
      schemaVersion: migrations.at(-1).created_at, schemaSha256, migrations, ledgerSha256: hash(JSON.stringify(migrations)),
      dumpFile: path.basename(file), dumpBytes: (await stat(file)).size, dumpSha256: await sha256(file) };
    await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await client.query("COMMIT");
  } finally { await client.end(); }
  await verifyBackup({ file });
  console.log(`Backup created and verified: ${file}`);
}

export function restoreList(list) {
  return list.split("\n").filter((line) => !/^\d+; \d+ \d+ SCHEMA - public(?: |$)/.test(line)).join("\n");
}

export async function restoreArchive(file, list, database) {
  const temporary = await mkdtemp(path.join(tmpdir(), "pstack-restore-"));
  const selection = path.join(temporary, "restore.list");
  try {
    await writeFile(selection, restoreList(list), { mode: 0o600 });
    await postgresTool("pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", "--use-list", selection, "--dbname", "", file], database, [path.dirname(file), temporary]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function restoreBackup(options, beforeRestore) {
  const { file, manifest, list } = await verifyBackup(options);
  if (!options.confirm) throw new Error("Restore requires --confirm and an empty target database");
  const database = postgresUrl(process.env.DATABASE_URL).href;
  const client = await connect(database);
  try {
    const objects = (await client.query("SELECT count(*)::int AS count FROM (SELECT c.relnamespace AS namespace FROM pg_class c UNION ALL SELECT p.pronamespace FROM pg_proc p UNION ALL SELECT t.typnamespace FROM pg_type t) objects JOIN pg_namespace n ON n.oid=objects.namespace WHERE n.nspname=ANY($1)", [schemas])).rows[0].count;
    if (objects) throw new Error("Restore target must have empty public and drizzle schemas; use a new database");
    await beforeRestore?.(client);
    await restoreArchive(file, list, database);
    const restoredLedger = await ledger(client);
    if (hash(JSON.stringify(restoredLedger)) !== manifest.ledgerSha256 || await schemaFingerprint(client) !== manifest.schemaSha256) throw new Error("Restored ledger or schema does not match the backup manifest");
  } finally { await client.end(); }
  console.log("Backup restored; database ledger and schema match the manifest");
}

export async function main(argv = process.argv.slice(2)) {
  loadEnvironment(root);
  process.umask(0o077);
  const options = parseArguments(argv);
  if (options.command === "create") return createBackup(options);
  if (options.command === "verify") { await verifyBackup(options); console.log("Backup archive and checksum verified"); return; }
  if (options.command === "restore") return restoreBackup(options);
  console.log("Usage: node scripts/db-backup.mjs create [--output NEW_DIRECTORY] | verify --file DUMP | restore --file DUMP --confirm\nDATABASE_URL must explicitly name a database. Restore accepts an empty database only. POSTGRES_TOOLS=local|docker.");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL redacted]");
    console.error(`Backup operation failed: ${message}`);
    process.exitCode = 1;
  });
}
