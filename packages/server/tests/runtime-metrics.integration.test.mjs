import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail("condition did not settle");
}

test("dedicated runtime metrics and upload admission against owned PostgreSQL", { timeout: 90000 }, async (t) => {
  const name = `pstack-metrics-${randomUUID()}`;
  const directory = await mkdtemp(path.join(tmpdir(), "pstack-metrics-"));
  let database;
  try {
    docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=isolated-test-only",
      "-e", "POSTGRES_DB=metrics_test", "-p", "127.0.0.1::5432", "postgres:17-bullseye");
    const port = docker("port", name, "5432/tcp").split(":").at(-1);
    Object.assign(process.env, {
      DATABASE_URL: `postgres://postgres:isolated-test-only@127.0.0.1:${port}/metrics_test`,
      NODE_ENV: "test", APP_ORIGIN: "http://localhost", LOG_LEVEL: "error",
      RATE_LIMIT_DRIVER: "memory", WEB_REPLICAS: "1", UPLOAD_STORAGE_DRIVER: "local",
      UPLOAD_STORAGE_DIR: path.join(directory, "storage"), UPLOAD_MAX_BYTES: "1024", UPLOAD_MAX_CONCURRENT: "1",
      METRICS_TOKEN: "metrics-test-token-0123456789-abcdefgh",
    });
    database = await import("@pstack/database/client");
    await until(async () => { try { await database.getPool().query("select 1"); return true; } catch { return false; } });
    execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, "../../../apps/web/tsconfig.json") }, stdio: "pipe",
    });
    const query = (sql, params) => database.getPool().query(sql, params);
    const { bootstrapAdministrator } = await import("../src/bootstrap-admin.ts");
    const credentials = { account: "metrics_admin", password: "Metrics-test-password-0134" };
    await bootstrapAdministrator(credentials);
    const { login } = await import("../src/auth-service.ts");
    const token = (await login(credentials)).token;
    const { GET } = await import("../../../apps/web/app/api/system/metrics/route.ts");
    const { POST } = await import("../../../apps/web/app/api/uploads/route.ts");
    const { uploadAdmissionSnapshot } = await import("../src/upload-admission.ts");
    const { runtimeMetricsSchema } = await import("@pstack/contracts/runtime-metrics");
    const metrics = (authorization = `Bearer ${process.env.METRICS_TOKEN}`) => GET(new Request("http://localhost/api/system/metrics", {
      headers: authorization ? { authorization } : {},
    }));
    const upload = (body, extra = {}) => POST(new Request("http://localhost/api/uploads", {
      method: "POST", headers: { authorization: `Bearer ${token}`, ...extra.headers }, body, ...extra,
    }));
    const form = () => { const body = new FormData(); body.set("file", new File(["hello"], "metrics.txt")); return body; };

    await t.test("missing, wrong, oversized and administrator credentials never query the database", async () => {
      let acquired = 0;
      const observe = () => acquired++;
      database.getPool().on("acquire", observe);
      try {
        for (const credential of [null, "Bearer wrong", `Bearer ${token}`, `Bearer ${"a".repeat(4096)}`]) {
          const response = await metrics(credential);
          assert.equal(response.status, 401);
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
        assert.equal(acquired, 0);
      } finally { database.getPool().off("acquire", observe); }
    });
    await t.test("fixed database facts, single-flight cache, and fresh pool queue", async () => {
      await query("insert into app_tasks(id,task_type,status,trace_id,created_at) values('metric-task','secret-type','running','secret-trace',now()-interval '1 hour')");
      await query("insert into app_outbox_events(id,topic,event_type,payload,trace_id,created_at) values('metric-outbox','secret-topic','test','{}','secret-trace',now()-interval '1 hour')");
      await query("insert into app_upload_intents(id,storage_key,provider,state) values('metric-intent','secret-path','local','blocked')");
      await query("insert into app_message_quarantine(id,consumer_group,topic,partition,source_offset,error_code,error_message) values('metric-q','secret-group','secret-topic',0,'0','bad','secret-error')");
      await query("insert into app_async_recovery_quarantine(idempotency_key,consumer_group,original_record,error_code,error_message) values('secret-key','secret-group','{}','bad','secret-error')");
      let acquired = 0;
      const observe = () => acquired++;
      database.getPool().on("acquire", observe);
      const responses = await Promise.all(Array.from({ length: 12 }, () => metrics()));
      database.getPool().off("acquire", observe);
      assert.equal(acquired, 1);
      const snapshots = await Promise.all(responses.map(async (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        return runtimeMetricsSchema.parse((await response.json()).data);
      }));
      const first = snapshots[0];
      assert.equal(first.database.status, "available");
      assert.equal(first.database.tasks.running, 1);
      assert.ok(first.database.tasks.oldestUnfinishedAgeMs >= 3599000);
      assert.equal(first.database.outbox.pending, Number((await query("select count(*) from app_outbox_events where status='pending'")).rows[0].count));
      assert.ok(first.database.outbox.oldestPendingAgeMs >= 3599000);
      assert.deepEqual(first.database.quarantine, { message: 1, recovery: 1 });
      assert.equal(first.database.uploads.blocked, 1);
      assert.ok(!JSON.stringify(first).includes("secret-"));
      assert.ok(first.http.every((entry) => entry.operationId !== "getApiSystemMetrics"));
      for (const snapshot of snapshots) assert.deepEqual(snapshot.database, first.database);
      const clients = await Promise.all(Array.from({ length: 10 }, () => database.getPool().connect()));
      const queued = query("select 1");
      try {
        const fresh = (await (await metrics()).json()).data;
        assert.equal(fresh.databasePool.waiting, 1);
        assert.equal(fresh.databasePool.idle, 0);
        assert.equal(fresh.databasePool.total, fresh.databasePool.max);
      } finally { clients.forEach((client) => client.release()); await queued; }
    });
    await t.test("stale outbox metrics match reclaimable leases including legacy null timestamps", async () => {
      const { readDatabaseMetrics } = await import("@pstack/database/operational-metrics");
      await query(`insert into app_outbox_events(id,topic,event_type,payload,trace_id,status,lease_until,locked_at)
        select 'lease-' || kind, 'fixture', 'test', '{}', 'lease-fixture', 'processing', lease_until, locked_at
        from (values
          ('expired', now()-interval '1 hour', null),
          ('live', now()+interval '1 hour', null),
          ('legacy-expired', null, now()-interval '1 hour'),
          ('legacy-live', null, now()+interval '1 hour'),
          ('legacy-no-clock', null, null),
          ('expired-precedence', now()-interval '1 hour', now()+interval '1 hour'),
          ('live-precedence', now()+interval '1 hour', now()-interval '1 hour')
        ) as leases(kind,lease_until,locked_at)`);
      try {
        const snapshot = await readDatabaseMetrics();
        assert.equal(snapshot.status, "available");
        assert.equal(snapshot.outbox.processing, 7);
        assert.equal(snapshot.outbox.staleLocks, 4);
      } finally { await query("delete from app_outbox_events where trace_id='lease-fixture'"); }
    });
    await t.test("unauthorized uploads do not buffer bodies or occupy admission", async () => {
      let reads = 0;
      const stream = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
      const response = await POST(new Request("http://localhost/api/uploads", {
        method: "POST", body: stream, duplex: "half",
      }));
      assert.equal(response.status, 401);
      assert.equal(reads, 0);
      assert.equal(uploadAdmissionSnapshot().active, 0);
      assert.equal(uploadAdmissionSnapshot().rejectedTotal, 0);
    });
    await t.test("overflow rejects before body buffering and disconnect keeps occupied slot through commit", async () => {
      const client = await database.getPool().connect();
      const controller = new AbortController();
      await client.query("begin; lock table app_file_assets in access exclusive mode");
      const pending = upload(form(), { signal: controller.signal });
      try {
        await until(async () => Number((await query("select count(*) from app_upload_intents where state='writing'")).rows[0].count) === 1);
        controller.abort();
        assert.equal(uploadAdmissionSnapshot().active, 1);
        assert.equal((await (await metrics()).json()).data.uploads.active, 1);
        let reads = 0;
        const stream = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
        const response = await upload(stream, { duplex: "half" });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "UPLOAD_BUSY");
        assert.equal(response.headers.get("retry-after"), "1");
        assert.equal(reads, 0);
        assert.equal(uploadAdmissionSnapshot().rejectedTotal, 1);
        assert.equal(uploadAdmissionSnapshot().active, 1);
      } finally { await client.query("commit"); client.release(); }
      assert.equal((await pending).status, 200);
      assert.equal(uploadAdmissionSnapshot().active, 0);
      assert.equal(Number((await query("select count(*) from app_file_assets")).rows[0].count), 1);
    });
    await t.test("malformed, oversized, stream and storage failures release slots", async () => {
      assert.equal((await upload("broken")).status, 400);
      const large = new FormData(); large.set("file", new File(["a".repeat(1025)], "large.txt"));
      assert.equal((await upload(large)).status, 413);
      assert.equal((await upload(new ReadableStream({ start(controller) { controller.error(new Error("connection lost")); } }), { duplex: "half" })).status, 500);
      await rm(process.env.UPLOAD_STORAGE_DIR, { recursive: true, force: true });
      await writeFile(process.env.UPLOAD_STORAGE_DIR, "blocks directory creation");
      assert.equal((await upload(form())).status, 500);
      assert.equal(Number((await query("select count(*) from app_upload_intents where state='cleanup'")).rows[0].count), 1);
      await rm(process.env.UPLOAD_STORAGE_DIR);
      assert.equal((await upload(form())).status, 200);
      assert.equal(uploadAdmissionSnapshot().active, 0);
    });
    await t.test("commit failure settles durable reconciliation before slot release", async () => {
      await query("create function reject_metric_file() returns trigger language plpgsql as $$ begin raise exception 'fixture rejection'; end $$; create trigger reject_metric_file before insert on app_file_assets for each row execute function reject_metric_file()");
      try {
        assert.equal((await upload(form())).status, 500);
        assert.equal(uploadAdmissionSnapshot().active, 0);
        assert.equal(Number((await query("select count(*) from app_upload_intents where state='deleted'")).rows[0].count), 1);
      } finally { await query("drop trigger reject_metric_file on app_file_assets; drop function reject_metric_file()"); }
    });
    await t.test("database failures are cached unavailable observations and recover after expiry", async () => {
      await pause(1100);
      await query("alter table app_tasks rename to unavailable_tasks");
      const first = (await (await metrics()).json()).data;
      assert.deepEqual(Object.keys(first.database).sort(), ["observedAt", "status"]);
      assert.equal(first.database.status, "unavailable");
      await query("alter table unavailable_tasks rename to app_tasks");
      assert.deepEqual((await (await metrics()).json()).data.database, first.database);
      await pause(1100);
      const recovered = (await (await metrics()).json()).data;
      assert.equal(recovered.database.status, "available");
      assert.notEqual(recovered.database.observedAt, first.database.observedAt);
      const uploadCounters = recovered.http.filter((row) => row.operationId === "postApiUploads");
      assert.equal(uploadCounters.find((row) => row.status === 503).count, 1);
      assert.ok(uploadCounters.find((row) => row.status === 500).count >= 3);
      assert.ok(uploadCounters.find((row) => row.status === 200).durationMsTotal > 0);
    });
  } finally {
    await database?.closeDatabase();
    docker("rm", "-f", name);
    await rm(directory, { recursive: true, force: true });
  }
});
