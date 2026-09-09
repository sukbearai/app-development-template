import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeDatabase, getPool } from "../src/client.ts";
import { getUserPage, getAuditPage } from "../src/admin-pages.ts";
import { userPageQuerySchema, auditPageQuerySchema } from "@pstack/contracts/admin-pages";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
test(
  "directory pagination, filters and literal searches use owned PostgreSQL",
  { timeout: 120000 },
  async () => {
    const name = `pstack-directory-${randomUUID()}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=isolated-test-only",
      "-e",
      "POSTGRES_DB=directory_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bullseye",
    );
    process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${docker("port", name, "5432/tcp").split(":").at(-1)}/directory_test`;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await getPool().query("select 1");
          break;
        } catch (error) {
          if (attempt >= 40) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], {
        env: process.env,
        stdio: "pipe",
      });
      await getPool()
        .query(`insert into app_users(id,account,display_name,password_hash,status,created_at)
      select 'user-'||n,'account-'||lpad(n::text,3,'0'),case when n=3 then 'Literal_%' else 'Member '||n end,'unused',
      case when n%2=0 then 'enabled' else 'disabled' end,'2026-01-01'::timestamptz from generate_series(1,57) n`);
      const query = userPageQuerySchema.parse({ limit: "20", sort: "account", direction: "asc" });
      const pages = await Promise.all([1, 2, 3].map((page) => getUserPage({ ...query, page })));
      assert.deepEqual(
        pages.map((page) => page.items.length),
        [20, 20, 17],
      );
      assert.ok(pages.every((page) => page.total === 57));
      assert.equal(new Set(pages.flatMap((page) => page.items.map((user) => user.id))).size, 57);
      assert.equal(pages[0].items[0].account, "account-001");
      assert.equal((await getUserPage(userPageQuerySchema.parse({ status: "enabled" }))).total, 28);
      assert.deepEqual(
        (await getUserPage(userPageQuerySchema.parse({ search: "_%" }))).items.map(
          (user) => user.id,
        ),
        ["user-3"],
      );
      assert.equal(
        (await getUserPage(userPageQuerySchema.parse({ search: "MEMBER 57" }))).items[0].id,
        "user-57",
      );
      await getPool()
        .query(`insert into app_audit_logs(id,action,trace_id,actor_id,target_id,created_at)
      select 'audit-'||lpad(n::text,3,'0'),case when n%2=0 then 'auth.login' else 'user.created' end,
      'trace-'||n,'actor-'||n,'target-'||n,'2026-01-01'::timestamptz from generate_series(1,137) n`);
      const auditQuery = auditPageQuerySchema.parse({ limit: "100" });
      const first = await getAuditPage(auditQuery);
      const second = await getAuditPage({ ...auditQuery, page: 2 });
      assert.deepEqual([first.items.length, second.items.length, first.total], [100, 37, 137]);
      assert.equal(new Set([...first.items, ...second.items].map((event) => event.id)).size, 137);
      const filtered = await getAuditPage(
        auditPageQuerySchema.parse({ search: "target-12", action: "auth.login" }),
      );
      assert.equal(filtered.total, 6);
      assert.ok(
        filtered.items.every(
          (event) => event.action === "auth.login" && event.targetId.includes("target-12"),
        ),
      );
      assert.equal(
        (await getAuditPage(auditPageQuerySchema.parse({ page: "999" }))).items.length,
        0,
      );
    } finally {
      await closeDatabase();
      docker("rm", "-f", "-v", name);
    }
  },
);
