import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getPool, closeDatabase } from "../src/client.ts";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (legacy = false) =>
  new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["db:migrate" + (legacy ? ":legacy" : "")], {
      cwd: new URL("..", import.meta.url),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
test(
  "legacy isolated database upgrades without rewriting history; concurrent migrate and drift rejection",
  { timeout: 120000 },
  async () => {
    const name = `pstack-migration-${randomUUID()}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=isolated-test-only",
      "-e",
      "POSTGRES_DB=migration_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bullseye",
    );
    const port = docker("port", name, "5432/tcp").split(":").at(-1);
    process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${port}/migration_test`;
    try {
      for (let i = 0; i < 40; i++) {
        try {
          await getPool().query("select 1");
          break;
        } catch {
          await pause(250);
        }
      }
      await getPool().query(
        "create schema drizzle; create table drizzle.drizzle_migrations(id serial primary key,hash text not null,created_at bigint)",
      );
      const journal = JSON.parse(
        await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
      );
      for (const entry of journal.entries) {
        const sql = await readFile(
          new URL(`../migrations/${entry.tag}.sql`, import.meta.url),
          "utf8",
        );
        await getPool().query(sql);
        await getPool().query(
          "insert into drizzle.drizzle_migrations(hash,created_at) values($1,$2)",
          [createHash("sha256").update(sql).digest("hex"), entry.when],
        );
      }
      const history = (
        await getPool().query("select * from drizzle.drizzle_migrations order by id")
      ).rows;
      await assert.rejects(run(), /explicit db:migrate:legacy/);
      await run(true);
      assert.deepEqual(
        (await getPool().query("select * from drizzle.drizzle_migrations order by id limit 3"))
          .rows,
        history,
      );
      assert.equal(
        (await getPool().query("select status from app_users where account='admin'")).rows[0]
          .status,
        "disabled",
      );
      execFileSync("pnpm", ["--filter", "@pstack/server", "admin:bootstrap", "--recover-legacy"], {
        cwd: new URL("../../..", import.meta.url),
        env: {
          ...process.env,
          BOOTSTRAP_ADMIN_ACCOUNT: "admin",
          BOOTSTRAP_ADMIN_PASSWORD: "recovered-strong-password",
        },
        encoding: "utf8",
      });
      const recovered = (
        await getPool().query("select status,password_hash from app_users where account='admin'")
      ).rows[0];
      assert.equal(recovered.status, "enabled");
      assert.match(recovered.password_hash, /^scrypt:/);
      await Promise.all([run(), run()]);
      assert.equal(
        Number(
          (await getPool().query("select count(*) from drizzle.drizzle_migrations")).rows[0].count,
        ),
        journal.entries.length +
          JSON.parse(
            await readFile(
              new URL("../migrations/template/meta/_journal.json", import.meta.url),
              "utf8",
            ),
          ).entries.length,
      );
      const { assertDatabaseSchema } = await import("../src/schema-check.ts");
      const connection = await getPool().connect();
      try {
        const cases = [
          ["alter table app_users add column unmanaged text", /unexpected column/],
          [
            "alter table app_users add constraint extra_check check (length(account)>1)",
            /unexpected constraint/,
          ],
          [
            "create unique index extra_unique on app_users(display_name)",
            /unexpected unique index/,
          ],
          ["alter table app_users drop constraint app_users_account_key", /unique constraint/],
          ["alter table app_user_roles drop constraint app_user_roles_user_id_fkey", /foreign key/],
          ["alter table app_users drop constraint app_users_status_check", /check/],
          ["alter table app_users alter column status set default 'disabled'", /default/],
          ["alter table app_roles alter column status set default 'ACTIVE'", /default/],
          ["drop index app_outbox_events_status_next_idx", /index/],
          [
            "drop index app_outbox_events_status_next_idx; create index app_outbox_events_status_next_idx on app_outbox_events(next_attempt_at,status)",
            /index/,
          ],
        ];
        for (const [ddl, failure] of cases) {
          await connection.query("begin");
          try {
            await connection.query(ddl);
            await assert.rejects(assertDatabaseSchema(connection), failure);
          } finally {
            await connection.query("rollback");
          }
          await assertDatabaseSchema(connection);
        }
      } finally {
        connection.release();
      }
      await getPool().query("alter table app_users drop column display_name");
      await assert.rejects(run(), /schema is missing app_users.display_name/);
      await getPool().query(
        "drop schema public cascade; drop schema drizzle cascade; create schema public; create schema drizzle; create table drizzle.drizzle_migrations(id serial primary key,hash text not null,created_at bigint)",
      );
      const templateJournal = JSON.parse(
        await readFile(
          new URL("../migrations/template/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      const baseline = await readFile(
        new URL(`../migrations/template/${templateJournal.entries[0].tag}.sql`, import.meta.url),
        "utf8",
      );
      await getPool().query(baseline);
      await getPool().query(
        "insert into drizzle.drizzle_migrations(hash,created_at) values($1,$2)",
        [createHash("sha256").update(baseline).digest("hex"), templateJournal.entries[0].when],
      );
      await getPool().query("alter table app_users add column unmanaged text");
      await assert.rejects(run(), /unexpected column/);
      assert.equal(
        (await getPool().query("select count(*) from drizzle.drizzle_migrations")).rows[0].count,
        "1",
      );
      await getPool().query("alter table app_users drop column unmanaged");
      await getPool().query("alter table app_users drop constraint app_users_account_unique");
      await assert.rejects(run(), /unique constraint/);
      assert.equal(
        (await getPool().query("select count(*) from drizzle.drizzle_migrations")).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await getPool().query(
            "select count(*) from information_schema.columns where table_schema='public' and table_name='app_upload_intents' and column_name='storage_location'",
          )
        ).rows[0].count,
        "0",
      );
    } finally {
      await closeDatabase();
      docker("rm", "-f", name);
    }
  },
);
