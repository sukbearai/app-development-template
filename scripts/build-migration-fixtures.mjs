#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { commandRunner, exportCheckout, isolatedEnvironment } from "./cold-start-support.mjs";
import { sourceHashes } from "../.agents/skills/verify-pstack-x/scripts/identity.mjs";

const usage =
  "Usage: node scripts/build-migration-fixtures.mjs [--root ABSOLUTE_REPO] --output .verification/artifacts/NEW_DIRECTORY\nBuilds base, nullable and NOT NULL web/worker images locally. Retains images and evidence; removes its temporary checkout.\n";
const { values, tokens } = parseArgs({
  options: { root: { type: "string" }, output: { type: "string" }, help: { type: "boolean" } },
  tokens: true,
});
if (new Set(tokens.map((token) => token.name)).size !== tokens.length)
  throw new Error("Duplicate arguments are not accepted.");
if (values.help) {
  if (tokens.length !== 1) throw new Error("Use --help alone.");
  process.stdout.write(usage);
} else {
  if (!values.output || (values.root && !path.isAbsolute(values.root))) throw new Error(usage);
  const root = await realpath(values.root ?? process.cwd());
  const output = path.resolve(root, values.output);
  const allowed = path.join(root, ".verification", "artifacts");
  if (!output.startsWith(`${allowed}${path.sep}`))
    throw new Error("--output must be a new directory below ROOT/.verification/artifacts/.");
  let ancestor = root;
  for (const part of path.relative(root, output).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    const info = await lstat(ancestor).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info && (!info.isDirectory() || ancestor === output))
      throw new Error("Output must not exist or traverse symlinks or non-directories.");
  }
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const result = { status: "building", root, images: [], variants: [], cleanupErrors: [] };
  let checkout, runner;
  const interrupt = () => {
    if (runner) void runner.interrupt();
  };
  const save = () =>
    writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  try {
    checkout = await realpath(await mkdtemp(path.join(tmpdir(), "pstack-migration-fixtures-")));
    result.source = await exportCheckout(root, checkout);
    runner = commandRunner(checkout, isolatedEnvironment(), (text) => {
      appendFileSync(path.join(output, "run.log"), text);
      process.stderr.write(text);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
    await runner.run("git", ["init", "--quiet"]);
    await runner.run("pnpm", ["install", "--frozen-lockfile"]);
    await runner.run("pnpm", ["hooks:install"]);
    const migrationDir = path.join(checkout, "packages/database/migrations/template");
    const schemaFile = path.join(checkout, "packages/database/src/schema.ts");
    const integrityFile = path.join(migrationDir, "integrity.json");
    const journal = async () =>
      JSON.parse(await readFile(path.join(migrationDir, "meta/_journal.json"), "utf8"));
    const suffix = randomUUID();
    async function buildVariant(name) {
      const variantOutput = path.join(output, name);
      await mkdir(variantOutput);
      await cp(migrationDir, path.join(variantOutput, "migrations"), { recursive: true });
      await cp(schemaFile, path.join(variantOutput, "schema.ts"));
      const hashes = sourceHashes(checkout);
      await writeFile(
        path.join(variantOutput, "source-sha256.json"),
        `${JSON.stringify(hashes, null, 2)}\n`,
      );
      result.variants.push({
        name,
        sourceSha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
      });
      await save();
      for (const target of ["web", "worker"]) {
        const tag = `pstack-migration-fixture-${suffix}:${name}-${target}`;
        const image = { variant: name, target, tag, id: null };
        result.images.push(image);
        await save();
        await runner.run("docker", ["build", "--target", target, "--tag", tag, "."]);
        image.id = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
        await save();
      }
    }
    await runner.run("pnpm", ["migration:check"]);
    await buildVariant("base");
    const schema = await readFile(schemaFile, "utf8");
    const roleStart = 'export const appRoles = pgTable(\n  "app_roles",\n  {';
    if (!schema.includes(roleStart) || schema.includes("deploymentNote"))
      throw new Error("Expected appRoles declaration without deploymentNote.");
    const nullable = `${roleStart}\n    deploymentNote: text("deployment_note"),`;
    const baseJournal = await journal();
    await writeFile(schemaFile, schema.replace(roleStart, nullable));
    await runner.run("pnpm", ["db:generate"]);
    const nullableJournal = await journal();
    if (nullableJournal.entries.length !== baseJournal.entries.length + 1)
      throw new Error("Expected exactly one new nullable migration.");
    const nullableSql = await readFile(
      path.join(migrationDir, `${nullableJournal.entries.at(-1).tag}.sql`),
      "utf8",
    );
    if (!/^ALTER TABLE "app_roles" ADD COLUMN "deployment_note" text;\s*$/.test(nullableSql))
      throw new Error("Unexpected generated nullable migration.");
    await buildVariant("nullable");
    const beforeIntegrity = await readFile(integrityFile);
    const beforeJournal = await journal();
    await writeFile(
      schemaFile,
      (await readFile(schemaFile, "utf8")).replace(
        'deploymentNote: text("deployment_note"),',
        'deploymentNote: text("deployment_note").notNull(),',
      ),
    );
    await runner.run("pnpm", ["db:generate"]);
    const afterJournal = await journal();
    if (afterJournal.entries.length !== beforeJournal.entries.length + 1)
      throw new Error("Expected exactly one new NOT NULL migration.");
    const sqlFile = path.join(migrationDir, `${afterJournal.entries.at(-1).tag}.sql`);
    const sql = await readFile(sqlFile, "utf8");
    if (!/^ALTER TABLE "app_roles" ALTER COLUMN "deployment_note" SET NOT NULL;\s*$/.test(sql))
      throw new Error("Unexpected generated NOT NULL migration.");
    await writeFile(integrityFile, beforeIntegrity);
    await writeFile(
      sqlFile,
      `UPDATE "app_roles" SET "deployment_note" = 'fixture' WHERE "deployment_note" IS NULL;\n--> statement-breakpoint\n${sql}`,
    );
    await runner.run("node", ["packages/database/scripts/migration-check.mjs", "--update"]);
    await runner.run("pnpm", ["migration:check"]);
    await buildVariant("not-null");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, interrupt);
    if (runner) await runner.stop().catch((error) => result.cleanupErrors.push(error.message));
    if (checkout)
      await rm(checkout, { recursive: true, force: true }).catch((error) =>
        result.cleanupErrors.push(error.message),
      );
    if (result.cleanupErrors.length) {
      result.status = "failed";
      process.exitCode = 1;
    }
    await save();
    await writeFile(
      path.join(output, "remove-images.json"),
      `${JSON.stringify(["docker", "image", "rm", ...result.images.map(({ tag }) => tag)], null, 2)}\n`,
    );
    process.stdout.write(
      `Evidence: ${output}\nStatus: ${result.status}\nImages are retained. remove-images.json contains the exact cleanup argv.\n`,
    );
  }
}
