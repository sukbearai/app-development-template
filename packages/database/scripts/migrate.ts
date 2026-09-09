import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { getPool, closeDatabase } from "../src/client";
import { assertDatabaseSchema, assertDatabaseSnapshot } from "../src/schema-check";
import { checkMigrations, migrationFolder } from "./migration-check.mjs";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export async function migrateDatabase() {
  const journal = await checkMigrations();
  const connection = await getPool().connect();
  try {
    await connection.query("select pg_advisory_lock(741829311)");
    const table = await connection.query(
      "select to_regclass('drizzle.drizzle_migrations') as ledger, to_regclass('public.app_users') as users",
    );
    if (!table.rows[0].ledger && table.rows[0].users)
      throw new Error("Existing application database has no recognized migration ledger");
    const applied = table.rows[0].ledger
      ? (
          await connection.query(
            "select hash, created_at from drizzle.drizzle_migrations order by created_at",
          )
        ).rows
      : [];
    const firstHash = hash(
      await readFile(path.join(migrationFolder, `${journal.entries[0].tag}.sql`)),
    );
    if (applied.length && applied[0].hash !== firstHash) {
      const historicalFolder = path.resolve(migrationFolder, "..");
      const legacy = JSON.parse(
        await readFile(path.join(historicalFolder, "meta/_journal.json"), "utf8"),
      );
      const integrity = JSON.parse(
        await readFile(path.join(historicalFolder, "migration-integrity.json"), "utf8"),
      );
      if (applied.length < legacy.entries.length)
        throw new Error("Legacy database must complete its original migration history first");
      for (let i = 0; i < legacy.entries.length; i++) {
        const entry = legacy.entries[i];
        const file = `${entry.tag}.sql`;
        const actual = hash(await readFile(path.join(historicalFolder, file)));
        if (
          actual !== integrity.migrations[file] ||
          applied[i].hash !== actual ||
          Number(applied[i].created_at) !== entry.when
        )
          throw new Error("Unknown or altered legacy migration history");
      }
      const upgrade = await readFile(
        path.join(historicalFolder, "legacy-upgrade/0004_safe_template.sql"),
        "utf8",
      );
      const manifest = JSON.parse(
        await readFile(path.join(historicalFolder, "legacy-upgrade/integrity.json"), "utf8"),
      );
      if (hash(upgrade) !== manifest["0004_safe_template.sql"])
        throw new Error("Legacy upgrade checksum differs");
      if (applied.length === legacy.entries.length) {
        if (!process.argv.includes("--legacy-upgrade"))
          throw new Error(
            "Legacy database requires explicit db:migrate:legacy; backup and credentials recovery are required",
          );
        await assertDatabaseSnapshot(
          connection,
          JSON.parse(
            await readFile(path.join(historicalFolder, "meta/0003_snapshot.json"), "utf8"),
          ),
        );
        await connection.query("begin");
        try {
          for (const statement of upgrade.split("--> statement-breakpoint"))
            await connection.query(statement);
          await connection.query(
            "insert into drizzle.drizzle_migrations(hash,created_at) values($1,$2)",
            [hash(upgrade), journal.entries[0].when],
          );
          await connection.query("commit");
        } catch (error) {
          await connection.query("rollback");
          throw error;
        }
      } else if (
        applied[legacy.entries.length].hash !== hash(upgrade) ||
        Number(applied[legacy.entries.length].created_at) !== journal.entries[0].when
      )
        throw new Error("Legacy upgrade history differs");
      const subsequent = applied.slice(legacy.entries.length + 1);
      for (let i = 0; i < subsequent.length; i++) {
        const entry = journal.entries[i + 1];
        if (
          !entry ||
          subsequent[i].hash !==
            hash(await readFile(path.join(migrationFolder, `${entry.tag}.sql`))) ||
          Number(subsequent[i].created_at) !== entry.when
        )
          throw new Error("Applied migration checksum differs");
      }
      await assertDatabaseSnapshot(
        connection,
        JSON.parse(
          await readFile(
            path.join(
              migrationFolder,
              "meta",
              `${String(subsequent.length).padStart(4, "0")}_snapshot.json`,
            ),
            "utf8",
          ),
        ),
      );
    } else {
      if (table.rows[0].users && !applied.length)
        throw new Error("Application tables exist without applied template history");
      for (let index = 0; index < applied.length; index++) {
        const entry = journal.entries[index];
        if (
          !entry ||
          applied[index].hash !==
            hash(await readFile(path.join(migrationFolder, `${entry.tag}.sql`))) ||
          Number(applied[index].created_at) !== entry.when
        )
          throw new Error("Applied migration checksum does not match template history");
      }
      if (applied.length)
        await assertDatabaseSnapshot(
          connection,
          JSON.parse(
            await readFile(
              path.join(
                migrationFolder,
                "meta",
                `${String(applied.length - 1).padStart(4, "0")}_snapshot.json`,
              ),
              "utf8",
            ),
          ),
        );
    }
    await migrate(drizzle(connection), {
      migrationsFolder: migrationFolder,
      migrationsSchema: "drizzle",
      migrationsTable: "drizzle_migrations",
    });
    await assertDatabaseSchema(connection);
  } finally {
    await connection
      .query("select pg_advisory_unlock(741829311)")
      .finally(() => connection.release());
  }
}
try {
  await migrateDatabase();
} finally {
  await closeDatabase();
}
