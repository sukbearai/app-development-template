#!/usr/bin/env node
import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { restoreArchive, verifyBackup } from "./db-backup.mjs";
import { run } from "./process.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Client } = await import("pg");
let server;
let control;
let containerId;
const postgresImage = process.env.BACKUP_TEST_POSTGRES_IMAGE || "postgres:17-bullseye";
process.env.POSTGRES_TOOLS = "docker";
process.env.POSTGRES_TOOL_IMAGE = postgresImage;
const suffix = randomUUID().replaceAll("-", "");
const source = `pstack_backup_source_${suffix}`;
const target = `pstack_backup_target_${suffix}`;
const conflict = `pstack_backup_conflict_${suffix}`;
const directory = await mkdtemp(path.join(tmpdir(), "pstack-backup-proof-"));
const certificates = path.join(directory, 'client certificates, "quoted"');
const serverCertificates = path.join(directory, "server-certificates");

function url(database) {
  const value = new URL(server);
  value.pathname = `/${database}`;
  value.searchParams.set("sslmode", "verify-full");
  for (const [option, filename] of [["sslrootcert", "ca.crt"], ["sslcert", "client.crt"], ["sslkey", "client.key"]]) {
    const file = path.join(certificates, filename);
    value.searchParams.set(option, database === target ? path.relative(root, file) : file);
  }
  return value.href;
}
async function command(args, database) {
  return run(process.execPath, [path.join(root, "scripts/db-backup.mjs"), ...args], { cwd: root, env: { ...process.env, DATABASE_URL: url(database) } });
}
try {
  await mkdir(certificates);
  await mkdir(serverCertificates);
  const openssl = (args) => run("openssl", args, { cwd: certificates, stdio: "ignore" });
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Backup test CA", "-keyout", "ca.key", "-out", "ca.crt"]);
  for (const name of ["server", "client"]) {
    await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name === "server" ? "localhost" : "app"}`, "-keyout", `${name}.key`, "-out", `${name}.csr`]);
    await writeFile(path.join(certificates, `${name}.ext`), name === "server"
      ? "subjectAltName=DNS:localhost,DNS:host.docker.internal\nextendedKeyUsage=serverAuth\n"
      : "extendedKeyUsage=clientAuth\n");
    await openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`]);
  }
  await chmod(path.join(certificates, "client.key"), 0o600);
  const privateKeyBefore = await stat(path.join(certificates, "client.key"));
  for (const filename of ["server.crt", "server.key", "ca.crt"]) {
    await writeFile(path.join(serverCertificates, filename), await readFile(path.join(certificates, filename)));
  }
  await writeFile(path.join(serverCertificates, "pg_hba.conf"), "local all all trust\nhostssl all all all cert\n");
  const password = randomUUID() + "/?#@%";
  containerId = (await run("docker", ["run", "--detach", "--name", `pstack-backup-proof-${suffix}`,
    "--label", "pstack.verification=backup", "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data",
    "--mount", `type=bind,source=${serverCertificates},target=/fixtures,readonly`,
    "--env", "POSTGRES_USER=app", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=postgres",
    "--entrypoint", "sh", postgresImage, "-ec",
    "mkdir /tmp/postgres-tls; cp /fixtures/* /tmp/postgres-tls/; chown -R postgres:postgres /tmp/postgres-tls; chmod 600 /tmp/postgres-tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/postgres-tls/server.crt -c ssl_key_file=/tmp/postgres-tls/server.key -c ssl_ca_file=/tmp/postgres-tls/ca.crt -c hba_file=/tmp/postgres-tls/pg_hba.conf"],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ["ignore", "pipe", "inherit"] })).trim();
  const inspection = JSON.parse(await run("docker", ["inspect", containerId], { stdio: ["ignore", "pipe", "inherit"] }))[0];
  const port = inspection.NetworkSettings.Ports["5432/tcp"][0].HostPort;
  server = new URL(`postgres://app@localhost:${port}/postgres`);
  server.password = encodeURIComponent(password);
  for (let attempt = 0; ; attempt++) {
    const candidate = new Client({ connectionString: url("postgres"), connectionTimeoutMillis: 1000 });
    try {
      await candidate.connect();
      await candidate.query("SELECT 1");
      control = candidate;
      break;
    } catch (error) {
      await candidate.end().catch(() => undefined);
      if (attempt >= 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const tls = (await control.query("SELECT ssl, client_dn FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
  assert.equal(tls.ssl, true);
  assert.equal(tls.client_dn, "/CN=app");
  for (const database of [source, target, conflict]) await control.query(`CREATE DATABASE "${database}"`);
  const client = new Client({ connectionString: url(source) });
  await client.connect();
  try {
    await client.query('CREATE TABLE public.backup_probe(id int PRIMARY KEY, value text NOT NULL); INSERT INTO public.backup_probe VALUES (1, \'preserved\'); CREATE SCHEMA drizzle; CREATE TABLE drizzle.drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    await client.query('INSERT INTO drizzle.drizzle_migrations(hash,created_at) VALUES ($1,1)', [createHash("sha256").update("fixture migration").digest("hex")]);
  } finally { await client.end(); }
  let output = path.join(directory, "backup");
  await command(["create", "--id", "proof", "--output", output], source);
  const specialOutput = path.join(directory, 'backup files, "quoted"');
  await rename(output, specialOutput);
  output = specialOutput;
  const file = path.join(output, "proof.dump");
  await command(["verify", "--file", file], source);
  await assert.rejects(command(["restore", "--file", file], target));
  await command(["restore", "--file", file, "--confirm"], target);
  await assert.rejects(command(["restore", "--file", file, "--confirm"], source));
  const conflicting = new Client({ connectionString: url(conflict) });
  await conflicting.connect();
  try {
    await conflicting.query("CREATE TABLE public.backup_probe(id int PRIMARY KEY, value text NOT NULL); INSERT INTO public.backup_probe VALUES (99, 'concurrent-value')");
    const verified = await verifyBackup({ file });
    await assert.rejects(restoreArchive(verified.file, verified.list, url(conflict)));
    assert.deepEqual((await conflicting.query("SELECT * FROM public.backup_probe")).rows, [{ id: 99, value: "concurrent-value" }]);
    assert.equal((await conflicting.query("SELECT to_regnamespace('drizzle') IS NULL AS absent")).rows[0].absent, true);
  } finally { await conflicting.end(); }
  const restored = new Client({ connectionString: url(target) });
  await restored.connect();
  try {
    assert.equal((await restored.query("SELECT value FROM public.backup_probe WHERE id=1")).rows[0].value, "preserved");
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM drizzle.drizzle_migrations")).rows[0].n, 1);
    await restored.query("BEGIN; ALTER TABLE public.backup_probe ADD COLUMN after_restore boolean NOT NULL DEFAULT false;");
    await restored.query("INSERT INTO drizzle.drizzle_migrations(hash,created_at) VALUES ($1,2)", [createHash("sha256").update("next fixture migration").digest("hex")]);
    await restored.query("COMMIT");
    assert.equal((await restored.query("SELECT after_restore FROM public.backup_probe")).rows[0].after_restore, false);
  } finally { await restored.end(); }
  const manifestFile = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.dumpSha256;
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(command(["restore", "--file", file, "--confirm"], target));
  const privateKeyAfter = await stat(path.join(certificates, "client.key"));
  assert.deepEqual([privateKeyAfter.mode, privateKeyAfter.uid, privateKeyAfter.gid], [privateKeyBefore.mode, privateKeyBefore.uid, privateKeyBefore.gid]);
  assert.deepEqual((await readdir(output)).sort(), ["manifest.json", "proof.dump"]);
  console.log("TLS backup proof passed: verify-full and client certificate authentication, absolute/relative certificate paths outside archive, quoted/comma/space mounts, unchanged private key permissions");
  console.log("Real backup proof passed: both schemas, ledger, row data, next migration, missing confirmation/checksum, nonempty target refusal, conflicting restore rollback");
} finally {
  try { if (control) await control.end(); }
  finally {
    try { if (containerId) await run("docker", ["rm", "--force", "--volumes", containerId], { stdio: "ignore" }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
