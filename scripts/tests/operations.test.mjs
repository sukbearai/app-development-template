import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvironment, postgresUrl } from "../env.mjs";
import { parseArguments, verifyBackup, postgresEnvironment, restoreList } from "../db-backup.mjs";
import { projectName, composeArgs, composeDatabaseUrl } from "../local.mjs";
import { verificationPlan } from "../pr-verify.mjs";
import { parseName } from "../template-init.mjs";

test("process overrides local overrides env, including explicit empty values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-env-"));
  try {
    await writeFile(
      path.join(root, ".env"),
      'DATABASE_URL=base\nAPP_NAME="base name"\nEMPTY=base\n',
    );
    await writeFile(path.join(root, ".env.local"), 'DATABASE_URL=local\nAPP_NAME="local name"\n');
    await writeFile(path.join(root, ".env.example"), "EXAMPLE_MUST_NOT_LOAD=yes\n");
    const env = loadEnvironment(root, { DATABASE_URL: "process", EMPTY: "" });
    assert.deepEqual(env, { DATABASE_URL: "process", EMPTY: "", APP_NAME: "local name" });
  } finally {
    await rm(root, { recursive: true });
  }
});
test("database URLs fail closed without a host and explicit database", () => {
  for (const value of [undefined, "", "postgres://localhost", "https://host/db", "not a url"])
    assert.throws(() => postgresUrl(value));
  assert.equal(postgresUrl("postgres://u:p@localhost:55432/app").pathname, "/app");
});
test("backup parser rejects missing paths and unsafe IDs before side effects", () => {
  for (const args of [
    ["verify"],
    ["restore", "--file"],
    ["create", "--id", "../../bad"],
    ["create", "--schema", "other"],
  ])
    assert.throws(() => parseArguments(args));
  assert.equal(parseArguments(["restore", "--file", "a.dump", "--confirm"]).confirm, true);
});
test("backup checksum is mandatory before pg_restore is invoked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-backup-"));
  try {
    const file = path.join(root, "bad.dump");
    await writeFile(file, "not an archive");
    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ format: "postgres-custom", dumpFile: "bad.dump" }),
    );
    await assert.rejects(verifyBackup({ file }), /Invalid or incomplete/);
  } finally {
    await rm(root, { recursive: true });
  }
});
test("project ownership is checkout-specific and down preserves volumes", () => {
  assert.notEqual(projectName("/a/template"), projectName("/b/template"));
  const args = composeArgs("/a/template", "down");
  assert.equal(args[args.indexOf("--project-name") + 1], projectName("/a/template"));
  assert.equal(args.at(-1), "down");
  assert.ok(!args.includes("--volumes") && !args.includes("--remove-orphans"));
  assert.throws(() => composeArgs("/a", "up", ["unknown"]));
  const worker = composeArgs("/a", "up", ["worker"]);
  for (const profile of ["worker", "app", "kafka"]) assert.ok(worker.includes(profile));
});
test("clean --full and every source/config/deployment path retain all required gates", () => {
  const full = verificationPlan([], { full: true });
  for (const gate of [
    "typecheck",
    "contract:check",
    "migration:check",
    "test:tools",
    "test:unit",
    "test:integration",
    "build",
    "db:integration",
    "test:e2e",
    "test:ui",
    "test:ui:production",
    "test:async-recovery",
    "test:kafka-security",
  ])
    assert.ok(full.includes(gate));
  for (const file of [
    "apps/web/lib/env.ts",
    "package.json",
    "pnpm-lock.yaml",
    "packages/server/src/auth.ts",
    "Dockerfile",
    "deploy/compose/docker-compose.yml",
    "unrecognized/path",
  ]) {
    assert.ok(verificationPlan([file], {}).includes("build"));
    assert.ok(verificationPlan([file], {}).includes("test:unit"));
  }
});
test("template rename requires an explicit bounded project name", () => {
  for (const args of [[], ["--name"], ["--name", "../escape"], ["--name", "$(id)"]])
    assert.throws(() => parseName(args));
  assert.equal(parseName(["--name", "new-project"]), "new-project");
});

test("template initialization synchronizes existing and missing environment files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pstack-template-init-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await copyFile(
      new URL("../template-init.mjs", import.meta.url),
      path.join(root, "scripts/template-init.mjs"),
    );
    await writeFile(path.join(root, "package.json"), '{"name":"pstack-x","private":true}\n');
    await writeFile(
      path.join(root, ".env.example"),
      'APP_NAME="Pstack App"\nDATABASE_URL=postgres://example\n',
    );
    await writeFile(
      path.join(root, ".env"),
      'APP_NAME="Local name"\nDATABASE_URL=postgres://local-secret\n',
    );

    const result = spawnSync(process.execPath, ["scripts/template-init.mjs", "--name", "prodevo"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).name,
      "prodevo",
    );
    assert.equal(
      await readFile(path.join(root, ".env.example"), "utf8"),
      'APP_NAME="prodevo"\nDATABASE_URL=postgres://example\n',
    );
    assert.equal(
      await readFile(path.join(root, ".env"), "utf8"),
      'APP_NAME="prodevo"\nDATABASE_URL=postgres://local-secret\n',
    );

    await rm(path.join(root, ".env"));
    const missingEnvResult = spawnSync(
      process.execPath,
      ["scripts/template-init.mjs", "--name", "next-project"],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(missingEnvResult.status, 0, missingEnvResult.stderr);
    assert.equal(
      await readFile(path.join(root, ".env.example"), "utf8"),
      'APP_NAME="next-project"\nDATABASE_URL=postgres://example\n',
    );
    assert.equal(
      await readFile(path.join(root, ".env"), "utf8"),
      'APP_NAME="next-project"\nDATABASE_URL=postgres://example\n',
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("production dependency filters survive root package renames", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.ok(!dockerfile.includes("--filter pstack-x"));
  assert.equal(dockerfile.match(/--filter \./g)?.length, 4);
});

test("PostgreSQL tool connection carries credentials in environment and rejects ambiguous overrides", () => {
  const env = postgresEnvironment(
    "postgres://user:encoded%40password@localhost:55432/app?sslmode=require",
  );
  assert.equal(env.PGPASSWORD, "encoded@password");
  assert.equal(env.PGPORT, "55432");
  assert.equal(env.PGSSLMODE, "require");
  assert.throws(
    () => postgresEnvironment("postgres://user:password@localhost/app?host=remote"),
    /Unsupported/,
  );
});

test("internal Compose database URL encodes credentials and database names", () => {
  const password = "secret/?#@:%value";
  const url = new URL(
    composeDatabaseUrl({
      POSTGRES_USER: "app@user",
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: "db/name?",
    }),
  );
  assert.equal(url.hostname, "postgres");
  assert.equal(decodeURIComponent(url.username), "app@user");
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "db/name?");
  assert.throws(() => composeDatabaseUrl({ POSTGRES_PASSWORD: "" }), /nonempty/);
});
test("restore selection omits only the default public schema creation", () => {
  const list =
    "1; 123 456 SCHEMA - public app\n2; 123 457 SCHEMA - drizzle app\n3; 123 458 TABLE public backup_probe app\n";
  const selected = restoreList(list);
  assert.ok(!selected.includes("SCHEMA - public"));
  assert.ok(selected.includes("SCHEMA - drizzle"));
  assert.ok(selected.includes("TABLE public backup_probe"));
});

test("Docker PostgreSQL tools use host networking for Linux loopback databases", async () => {
  const { dockerPostgresNetwork } = await import("../db-backup.mjs");
  for (const host of ["localhost", "127.0.0.1", "::1"]) {
    assert.deepEqual(dockerPostgresNetwork(host, "linux"), { host, args: ["--network=host"] });
    assert.deepEqual(dockerPostgresNetwork(host, "darwin"), {
      host: "host.docker.internal",
      args: ["--add-host=host.docker.internal:host-gateway"],
    });
  }
  assert.deepEqual(dockerPostgresNetwork("db.example", "linux"), { host: "db.example", args: [] });
  assert.deepEqual(dockerPostgresNetwork(undefined, "linux"), { host: undefined, args: [] });
});
