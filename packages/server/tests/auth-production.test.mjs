import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loginRequestSchema, createUserRequestSchema } from "@pstack/contracts";
import { hashPassword, verifyPassword } from "../src/password.ts";
import { createHook } from "node:async_hooks";

const workspace = path.resolve(import.meta.dirname, "../../..");
const execute = promisify(execFile);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (source, extra = {}) => execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { cwd: path.join(workspace, "packages/server"), env: { ...process.env, NODE_ENV: "test", ...extra } });

test("HTTP password schemas preserve the bootstrap and new-user credential bytes", async () => {
  const password = "  exact-password-value  ";
  const encoded = await hashPassword(password);
  assert.equal(await verifyPassword(loginRequestSchema.parse({ account: " admin ", password }).password, encoded), true);
  assert.equal(createUserRequestSchema.parse({ account: "user", displayName: "User", password }).password, password);
  assert.equal(await verifyPassword(password.trim(), encoded), false);
});

test("memory saturation keeps existing limits and blocks new keys until expiry", async () => {
  await run(`
    import assert from 'node:assert/strict';
    import { assertRateLimit } from './src/rate-limit.ts';
    assertRateLimit('victim', { limit: 1, windowMs: 100 });
    assert.throws(() => assertRateLimit('victim', { limit: 1 }), e => e.status === 429);
    assertRateLimit('other');
    assert.throws(() => assertRateLimit('overflow'), e => e.status === 429);
    assert.throws(() => assertRateLimit('victim', { limit: 1 }), e => e.status === 429);
    await new Promise(resolve => setTimeout(resolve, 130));
    assertRateLimit('victim', { limit: 1 });
  `, { RATE_LIMIT_DRIVER: "memory", LOGIN_RATE_LIMIT_MEMORY_MAX_KEYS: "2" });
});

test("multiple Web processes require a shared limiter", async () => {
  await assert.rejects(run("await import('./src/env.ts')", { WEB_REPLICAS: "2", RATE_LIMIT_DRIVER: "memory" }), /RATE_LIMIT_DRIVER=redis/);
});

test("independent Redis clients share an overall login budget and fail closed", { timeout: 60000 }, async () => {
  const name = `pstack-auth-redis-${randomUUID()}`;
  docker("run", "-d", "--name", name, "-p", "127.0.0.1::6379", "redis:5.0.8");
  try {
    for (let i = 0; i < 40; i++) {
      try { if (docker("exec", name, "redis-cli", "ping") === "PONG") break; } catch {}
      await pause(100);
    }
    const port = docker("port", name, "6379/tcp").split(":").at(-1);
    const config = { RATE_LIMIT_DRIVER: "redis", WEB_REPLICAS: "2", REDIS_URL: `redis://127.0.0.1:${port}/7`, LOGIN_RATE_LIMIT_GLOBAL_MAX: "4" };
    const source = `
      import { assertOverallLoginRateLimit } from './src/rate-limit.ts';
      import { closeRedis } from './src/redis-client.ts';
      let accepted=0;
      try { for(let i=0;i<3;i++) { try { await assertOverallLoginRateLimit(); accepted++; } catch(e) { if(e.status!==429) throw e; } } }
      finally { await closeRedis(); }
      process.stdout.write(String(accepted));
    `;
    const results = await Promise.all([run(source, config), run(source, config)]);
    assert.equal(results.reduce((sum, result) => sum + Number(result.stdout), 0), 4);
    docker("stop", name);
    await assert.rejects(run(source, config));
  } finally { try { docker("rm", "-f", name); } catch {} }
});

test("password lifecycle commits hashes, revocations, audit and outbox atomically", { timeout: 120000 }, async (t) => {
  const name = `pstack-auth-db-${randomUUID()}`;
  docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=isolated-test-only", "-e", "POSTGRES_DB=pstack_test", "-p", "127.0.0.1::5432", "postgres:17-bullseye");
  const port = docker("port", name, "5432/tcp").split(":").at(-1);
  process.env.DATABASE_URL = `postgres://postgres:isolated-test-only@127.0.0.1:${port}/pstack_test`;
  process.env.NODE_ENV = "test";
  process.env.RATE_LIMIT_DRIVER = "memory";
  const { getPool, closeDatabase } = await import("@pstack/database/client");
  try {
    for (let i = 0; i < 40; i++) { try { await getPool().query("select 1"); break; } catch { await pause(200); } }
    execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], { cwd: workspace, env: process.env, stdio: "pipe" });
    const query = (sql, args = []) => getPool().query(sql, args);
    const { bootstrapAdministrator } = await import("../src/bootstrap-admin.ts");
    const { recoverAdministrator } = await import("../src/recover-admin.ts");
    const auth = await import("../src/auth-service.ts");
    const adminCredentials = { account: "administrator", password: "  bootstrap-password  " };
    const admin = await bootstrapAdministrator(adminCredentials);
    let adminToken = (await auth.login(loginRequestSchema.parse(adminCredentials))).token;
    const userPassword = "  user-password-value  ";
    const user = await auth.createManagedUser(createUserRequestSchema.parse({ account: "regular", displayName: "Regular", password: userPassword }), adminToken);
    let userToken = (await auth.login({ account: user.account, password: userPassword })).token;

    await t.test("every rejected account performs password work without creating a session", async () => {
      const disabled = await auth.createManagedUser({ account: "disabled-login", displayName: "Disabled", password: "disabled-password", roleIds: [], status: "disabled" }, adminToken);
      const before = (await query("select count(*) from app_user_sessions")).rows[0].count;
      const attempts = [
        { account: user.account, password: "wrong-password" },
        { account: "missing-login", password: "wrong-password" },
        { account: disabled.account, password: "disabled-password" },
      ];
      for (const legacy of [false, true]) {
        if (legacy) await query("update app_users set password_hash='plain:disabled-password' where id=$1", [disabled.id]);
        for (const attempt of legacy ? attempts.slice(2) : attempts) {
          let passwordJobs = 0;
          const hook = createHook({ init(_id, type) { if (type === "SCRYPTREQUEST") passwordJobs++; } });
          hook.enable();
          try {
            await assert.rejects(auth.login(attempt), error => error.status === 401 && error.code === "INVALID_CREDENTIALS");
          } finally { hook.disable(); }
          assert.equal(passwordJobs, 1, `${attempt.account} must perform one password derivation`);
        }
      }
      assert.equal((await query("select count(*) from app_user_sessions")).rows[0].count, before);
    });

    await t.test("historical long credentials can log in and rotate", async () => {
      const oldPassword = 'legacy-'.repeat(40);
      const legacy = await auth.createManagedUser({ account: 'legacy-long', displayName: 'Legacy', password: 'temporary-value', roleIds: [], status: 'enabled' }, adminToken);
      await query('update app_users set password_hash=$1 where id=$2', [await hashPassword(oldPassword), legacy.id]);
      const token = (await auth.login({ account: legacy.account, password: oldPassword })).token;
      await auth.changePassword({ currentPassword: oldPassword, newPassword: 'current-valid-password' }, token);
      await assert.rejects(auth.getCurrentUser(token), error => error.status === 401);
      assert.equal((await auth.login({ account: legacy.account, password: 'current-valid-password' })).user.id, legacy.id);
    });

    await t.test("denied reset attempts cannot change credentials or revoke sessions", async () => {
      await assert.rejects(auth.resetManagedUserPassword(admin.id, { newPassword: "replacement-value" }, userToken), e => e.status === 403);
      await assert.rejects(auth.resetManagedUserPassword(admin.id, { newPassword: "replacement-value" }, adminToken), e => e.code === "CURRENT_PASSWORD_REQUIRED");
      await assert.rejects(auth.changePassword({ currentPassword: "wrong", newPassword: "replacement-value" }, userToken), e => e.code === "INVALID_CURRENT_PASSWORD");
      assert.equal((await auth.getCurrentUser(userToken)).user.id, user.id);
    });

    await t.test("concurrent rotations accept one replacement and invalidate every old session", async () => {
      const otherToken = (await auth.login({ account: user.account, password: userPassword })).token;
      const attempts = await Promise.allSettled([" replacement-one ", " replacement-two "].map(newPassword => auth.changePassword({ currentPassword: userPassword, newPassword }, userToken, "rotation")));
      assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
      for (const token of [userToken, otherToken]) await assert.rejects(auth.getCurrentUser(token), e => e.status === 401);
      await assert.rejects(auth.login({ account: user.account, password: userPassword }), e => e.status === 401);
      const winner = attempts[0].status === "fulfilled" ? " replacement-one " : " replacement-two ";
      userToken = (await auth.login({ account: user.account, password: winner })).token;
      const rows = (await query("select * from app_audit_logs where action='auth.password.change' and target_id=$1", [user.id])).rows;
      assert.equal(rows.length, 1);
      assert.equal((await query("select count(*) from app_outbox_events where payload->>'auditId'=$1", [rows[0].id])).rows[0].count, "1");
      assert.doesNotMatch(JSON.stringify(rows), /replacement|scrypt:/);
    });

    await t.test("outbox failure rolls back password replacement and revocation", async () => {
      const before = (await query("select password_hash from app_users where id=$1", [user.id])).rows[0];
      await query("create function reject_auth_outbox() returns trigger language plpgsql as $$ begin raise exception 'isolated outbox fault'; end $$; create trigger reject_auth_outbox before insert on app_outbox_events for each row execute function reject_auth_outbox()");
      try { await assert.rejects(auth.resetManagedUserPassword(user.id, { newPassword: "failed-replacement" }, adminToken)); }
      finally { await query("drop trigger reject_auth_outbox on app_outbox_events; drop function reject_auth_outbox()"); }
      assert.deepEqual((await query("select password_hash from app_users where id=$1", [user.id])).rows[0], before);
      assert.equal((await auth.getCurrentUser(userToken)).user.id, user.id);
    });

    await t.test("administrator reset revokes stale sessions; revoked actors cannot reset", async () => {
      assert.deepEqual(await auth.resetManagedUserPassword(user.id, { newPassword: " reset-password-value " }, adminToken), { updated: true });
      await assert.rejects(auth.getCurrentUser(userToken), e => e.status === 401);
      await auth.login({ account: user.account, password: " reset-password-value " });
      const stale = (await auth.login(adminCredentials)).token;
      await auth.logout(stale);
      await assert.rejects(auth.resetManagedUserPassword(user.id, { newPassword: "unauthorized-reset" }, stale), e => e.status === 401);
    });

    await t.test("reset rechecks administrator rights after hashing and waiting for the identity lock", async () => {
      await auth.createManagedRole({ id: "resetter", name: "Resetter", status: "active", permissionIds: ["admin.write"] }, adminToken);
      const resetter = await auth.createManagedUser({ account: "resetter", displayName: "Resetter", password: "resetter-password", status: "enabled", roleIds: ["resetter"] }, adminToken);
      const resetterToken = (await auth.login({ account: resetter.account, password: "resetter-password" })).token;
      const lock = await getPool().connect();
      let attempt;
      try {
        await lock.query("begin");
        await lock.query("select pg_advisory_xact_lock(741829310)");
        attempt = auth.resetManagedUserPassword(user.id, { newPassword: "must-never-be-set" }, resetterToken);
        const denied = assert.rejects(attempt, e => e.status === 403);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          waiting = (await query("select exists(select 1 from pg_locks where locktype='advisory' and not granted) waiting")).rows[0].waiting;
          if (waiting) break;
          await pause(20);
        }
        assert.equal(waiting, true, "reset reached transaction revalidation after hashing");
        await lock.query("update app_roles set status='inactive' where id='resetter'");
        await lock.query("commit");
        await denied;
        await auth.login({ account: user.account, password: " reset-password-value " });
      } finally {
        await lock.query("rollback");
        lock.release();
        await attempt?.catch(() => undefined);
      }
    });

    await t.test("operator CLI requires confirmation and recovers modern administrator without leaking credentials", async () => {
      const replacement = " operator-new-password ";
      const cliEnv = { ...process.env, ADMIN_RECOVERY_PASSWORD: replacement };
      await assert.rejects(execute(process.execPath, ["--import", "tsx", "scripts/recover-admin.ts", "--account", adminCredentials.account], { cwd: path.join(workspace, "packages/server"), env: cliEnv }), e => !`${e.stdout}${e.stderr}`.includes(replacement));
      assert.equal((await auth.getCurrentUser(adminToken)).user.id, admin.id);
      const result = await execute(process.execPath, ["--import", "tsx", "scripts/recover-admin.ts", "--account", adminCredentials.account, "--confirm"], { cwd: path.join(workspace, "packages/server"), env: cliEnv });
      assert.equal(JSON.parse(result.stdout).recovered, true);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(replacement));
      await assert.rejects(auth.getCurrentUser(adminToken), e => e.status === 401);
      await assert.rejects(auth.login(adminCredentials), e => e.status === 401);
      adminToken = (await auth.login({ account: adminCredentials.account, password: replacement })).token;
      await assert.rejects(recoverAdministrator({ account: user.account, newPassword: replacement, confirm: true }));
      const row = (await query("select * from app_audit_logs where action='admin.credentials.recovered'")).rows[0];
      assert.equal(row.metadata.channel, "operator-cli");
    });
  } finally { await closeDatabase(); docker("rm", "-f", name); }
});
