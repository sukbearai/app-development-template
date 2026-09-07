import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const workspace = path.resolve(import.meta.dirname, "../../..");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test(
  "PostgreSQL identity, atomic events and durable upload reconciliation",
  { timeout: 120000 },
  async (t) => {
    const name = `pstack-server-${randomUUID()}`;
    const storage = await mkdtemp(path.join(os.tmpdir(), "pstack-storage-"));
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=isolated-test-only",
      "-e",
      "POSTGRES_DB=pstack_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bullseye",
    );
    const port = docker("port", name, "5432/tcp").split(":").at(-1);
    process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${port}/pstack_test`;
    process.env.UPLOAD_STORAGE_DIR = storage;
    process.env.NODE_ENV = "test";
    const { getPool, closeDatabase } = await import("@pstack/database/client");
    try {
      for (let i = 0; i < 40; i++) {
        try {
          await getPool().query("select 1");
          break;
        } catch {
          await pause(250);
        }
      }
      const migrate = () =>
        execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], {
          cwd: workspace,
          env: process.env,
          encoding: "utf8",
        });
      migrate();
      migrate();
      const query = (sql, args = []) => getPool().query(sql, args);
      assert.equal(
        Number((await query("select count(*) from app_users")).rows[0].count),
        0,
      );
      assert.equal(
        Number(
          (await query("select count(*) from drizzle.drizzle_migrations"))
            .rows[0].count,
        ),
        2,
      );
      const { bootstrapAdministrator } = await import(
        "../src/bootstrap-admin.ts"
      );
      const auth = await import("../src/auth-service.ts");
      const product = await import("../src/product-service.ts");
      const credentials = {
        account: "test-admin",
        password: "test-strong-password-abc123",
      };
      const admin = await bootstrapAdministrator(credentials);
      const adminToken = (await auth.login(credentials)).token;
      assert.equal(admin.created, true);
      assert.equal((await bootstrapAdministrator(credentials)).created, false);
      await assert.rejects(
        bootstrapAdministrator({
          ...credentials,
          password: "another-strong-password",
        }),
      );
      await t.test(
        "wrong logout secret cannot revoke; disabled roles grant no permissions",
        async () => {
          const login = await auth.login(credentials);
          await auth.logout(`${login.token.split(".")[0]}.incorrect`);
          assert.equal(
            (await auth.getCurrentUser(login.token)).user.id,
            admin.id,
          );
          await auth.createManagedRole(
            {
              id: "inactive",
              name: "Inactive",
              status: "inactive",
              permissionIds: ["file.upload"],
            },
            adminToken,
            "integration",
          );
          const user = await auth.createManagedUser(
            {
              account: "regular-user",
              displayName: "Regular",
              password: "regular-strong-pass",
              status: "enabled",
              roleIds: ["inactive"],
            },
            adminToken,
            "integration",
          );
          const session = await auth.login({
            account: user.account,
            password: "regular-strong-pass",
          });
          await assert.rejects(
            auth.requirePermission(session.token, "file.upload"),
            (error) => error.status === 403,
          );
          await auth.updateManagedUser(
            user.id,
            { status: "disabled" },
            adminToken,
            "integration",
          );
          await auth.updateManagedUser(
            user.id,
            { status: "enabled" },
            adminToken,
            "integration",
          );
          await assert.rejects(
            auth.getCurrentUser(session.token),
            (error) => error.status === 401,
          );
          const expired = await auth.login(credentials);
          await query(
            "update app_user_sessions set expires_at=now()-interval '1 second' where id=$1",
            [expired.session.id],
          );
          await assert.rejects(
            auth.getCurrentUser(expired.token),
            (error) => error.status === 401,
          );
          await auth.logout(login.token);
          await assert.rejects(
            auth.getCurrentUser(login.token),
            (error) => error.status === 401,
          );
        },
      );
      await t.test(
        "last administrator and conflicting role creation stay consistent",
        async () => {
          await assert.rejects(
            auth.updateManagedUser(
              admin.id,
              { status: "disabled" },
              adminToken,
              "integration",
            ),
            (error) => error.code === "LAST_ADMINISTRATOR",
          );
          await assert.rejects(
            auth.updateManagedRole(
              "role_admin",
              { status: "inactive" },
              adminToken,
              "integration",
            ),
            (error) => error.code === "LAST_ADMINISTRATOR",
          );
          const attempts = await Promise.allSettled(
            [1, 2].map(() =>
              auth.createManagedRole(
                {
                  id: "unique-role",
                  name: "Unique",
                  status: "active",
                  permissionIds: [],
                },
                adminToken,
                "integration",
              ),
            ),
          );
          assert.equal(
            attempts.filter((item) => item.status === "fulfilled").length,
            1,
          );
        },
      );
      await t.test(
        "writes revalidate revoked permissions and upload credentials after body reading",
        async () => {
          await auth.createManagedRole(
            {
              id: "revocable",
              name: "Revocable",
              status: "active",
              permissionIds: ["admin.write", "file.upload"],
            },
            adminToken,
            "test",
          );
          const actor = await auth.createManagedUser(
            {
              account: "revocable-user",
              displayName: "Revocable",
              password: "revocable-password",
              status: "enabled",
              roleIds: ["revocable"],
            },
            adminToken,
            "test",
          );
          const token = (
            await auth.login({
              account: actor.account,
              password: "revocable-password",
            })
          ).token;
          await auth.requirePermission(token, "admin.write");
          let releaseRead;
          const reading = new Promise((resolve) => {
            releaseRead = resolve;
          });
          let signalRead;
          const started = new Promise((resolve) => {
            signalRead = resolve;
          });
          class PausedFile extends File {
            async arrayBuffer() {
              signalRead();
              await reading;
              return super.arrayBuffer();
            }
          }
          const upload = product.storeUploadedFile({
            file: new PausedFile(["blocked"], "blocked.txt"),
            actorId: actor.id,
            token,
            traceId: "revoked-upload",
          });
          await started;
          await auth.updateManagedRole(
            "revocable",
            { status: "inactive" },
            adminToken,
            "test",
          );
          releaseRead();
          await assert.rejects(upload, (error) => error.status === 403);
          const rejected = [
            () =>
              auth.createManagedUser(
                {
                  account: "forbidden",
                  displayName: "Forbidden",
                  password: "forbidden-password",
                  status: "enabled",
                  roleIds: [],
                },
                token,
                "test",
              ),
            () =>
              auth.updateManagedUser(
                actor.id,
                { displayName: "Changed" },
                token,
                "test",
              ),
            () =>
              auth.createManagedRole(
                {
                  id: "forbidden-role",
                  name: "Forbidden",
                  status: "active",
                  permissionIds: [],
                },
                token,
                "test",
              ),
            () =>
              auth.updateManagedRole(
                "revocable",
                { status: "active" },
                token,
                "test",
              ),
          ];
          for (const operation of rejected)
            await assert.rejects(operation(), (error) => error.status === 403);
          assert.equal(
            (
              await query(
                "select count(*) from app_users where account='forbidden'",
              )
            ).rows[0].count,
            "0",
          );
          assert.equal(
            (
              await query(
                "select count(*) from app_file_assets where file_name='blocked.txt'",
              )
            ).rows[0].count,
            "0",
          );
          await auth.logout(token);
          await assert.rejects(rejected[0](), (error) => error.status === 401);
          await assert.rejects(
            auth.updateManagedUser(
              actor.id,
              { displayName: "Changed" },
              undefined,
            ),
            (error) => error.status === 401,
          );
        },
      );
      await t.test(
        "outbox insertion failure rolls back user, session, telemetry and audit writes",
        async () => {
          const before = (
            await query(
              "select (select count(*) from app_users) users,(select count(*) from app_audit_logs) audit,(select count(*) from app_user_sessions) sessions,(select count(*) from app_telemetry_events) telemetry",
            )
          ).rows[0];
          await query(
            "create function test_reject_outbox() returns trigger language plpgsql as $$ begin raise exception 'test outbox failure'; end $$; create trigger test_fail_outbox before insert on app_outbox_events for each row execute function test_reject_outbox()",
          );
          await assert.rejects(
            auth.createManagedUser(
              {
                account: "rollback-user",
                displayName: "Rollback",
                password: "rollback-password",
                status: "enabled",
                roleIds: [],
              },
              adminToken,
              "integration",
            ),
          );
          await assert.rejects(auth.login(credentials));
          await assert.rejects(
            product.recordTelemetry({
              event: "rollback",
              traceId: "integration",
            }),
          );
          const after = (
            await query(
              "select (select count(*) from app_users) users,(select count(*) from app_audit_logs) audit,(select count(*) from app_user_sessions) sessions,(select count(*) from app_telemetry_events) telemetry",
            )
          ).rows[0];
          assert.deepEqual(after, before);
          await query(
            "drop trigger test_fail_outbox on app_outbox_events; drop function test_reject_outbox()",
          );
        },
      );
      await t.test(
        "failed file commit remains tracked and successful refs survive cleanup",
        async () => {
          const good = await product.storeUploadedFile({
            token: adminToken,
            file: new File(["hello"], "hello.txt"),
            traceId: "upload-ok",
          });
          assert.equal(
            await readFile(path.join(storage, good.storageKey), "utf8"),
            "hello",
          );
          assert.equal(
            await product.reconcileUploadIntent(good.storageKey),
            "protected",
          );
          await query(
            "create function test_reject_file() returns trigger language plpgsql as $$ begin raise exception 'test file failure'; end $$; create trigger test_fail_file before insert on app_file_assets for each row execute function test_reject_file()",
          );
          await assert.rejects(
            product.storeUploadedFile({
              token: adminToken,
              file: new File(["orphan"], "orphan.txt"),
              traceId: "upload-failed",
            }),
          );
          const failed = (
            await query(
              "select * from app_upload_intents where state='deleted'",
            )
          ).rows;
          assert.equal(failed.length, 2);
          assert.deepEqual(await readdir(storage), [good.storageKey]);
          const before = (
            await query("select * from app_upload_intents order by id")
          ).rows;
          await product.reconcileUploads({
            dryRun: true,
            staleBefore: new Date(Date.now() + 1000),
          });
          assert.deepEqual(
            (await query("select * from app_upload_intents order by id")).rows,
            before,
          );
          await query(
            "drop trigger test_fail_file on app_file_assets; drop function test_reject_file()",
          );
        },
      );
    } finally {
      await closeDatabase();
      docker("rm", "-f", name);
      await rm(storage, { recursive: true, force: true });
    }
  },
);
test(
  "Redis authenticates, selects database and atomically sets window expiration",
  { timeout: 60000 },
  async () => {
    const name = `pstack-redis-${randomUUID()}`;
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      "127.0.0.1::6379",
      "redis:5.0.8",
      "redis-server",
      "--requirepass",
      "isolated-redis-test",
    );
    const port = docker("port", name, "6379/tcp").split(":").at(-1);
    const url = `redis://:isolated-redis-test@127.0.0.1:${port}/3`;
    const { redisWindowCount, redisCommand, closeRedis } = await import(
      "../src/redis-client.ts"
    );
    try {
      for (let i = 0; i < 30; i++) {
        try {
          await redisCommand(url, ["PING"]);
          break;
        } catch {
          await pause(100);
        }
      }
      const counts = await Promise.all(
        Array.from({ length: 25 }, () =>
          redisWindowCount(url, "integration-window", 5000),
        ),
      );
      assert.deepEqual(
        counts.map((item) => item.count).sort((a, b) => a - b),
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
      assert.ok(counts.every((item) => item.ttlMs > 0 && item.ttlMs <= 5000));
      assert.equal(
        await redisCommand(url, ["GET", "integration-window"]),
        "25",
      );
      assert.equal(
        await redisCommand(url.replace("/3", "/0"), [
          "GET",
          "integration-window",
        ]),
        null,
      );
      await redisCommand(url.replace("/3", "/0"), [
        "CLIENT",
        "KILL",
        "TYPE",
        "normal",
        "SKIPME",
        "yes",
      ]);
      await pause(100);
      assert.equal(
        (await redisWindowCount(url, "reconnected-window", 5000)).count,
        1,
      );
    } finally {
      await closeRedis();
      docker("rm", "-f", name);
    }
  },
);
