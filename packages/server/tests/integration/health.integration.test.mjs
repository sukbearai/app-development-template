import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();

test(
  "health route bounds real database probes and refreshes failed snapshots",
  { timeout: 60000 },
  async (t) => {
    const name = `pstack-health-db-${randomUUID()}`;
    let control;
    let closeDatabase;
    try {
      docker(
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-e",
        "POSTGRES_PASSWORD=isolated-test-only",
        "-e",
        "POSTGRES_DB=health_test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17-bullseye",
      );
      const port = docker("port", name, "5432/tcp").split(":").at(-1);
      const address = `127.0.0.1:${port}/health_test`;
      control = new pg.Pool({
        connectionString: `postgres://postgres:isolated-test-only@${address}`,
      });
      for (let attempt = 0; ; attempt++) {
        try {
          await control.query("select 1");
          break;
        } catch (error) {
          if (attempt === 60) throw error;
          await pause(100);
        }
      }
      await control.query("create role health_user login password 'isolated-test-only'");
      Object.assign(process.env, {
        DATABASE_URL: `postgres://health_user:isolated-test-only@${address}`,
        NODE_ENV: "test",
        APP_ENV: "test",
        APP_ORIGIN: "http://localhost",
        LOG_LEVEL: "error",
        RATE_LIMIT_DRIVER: "memory",
        WEB_REPLICAS: "1",
        UPLOAD_STORAGE_DRIVER: "local",
        OUTBOX_PUBLISHER: "disabled",
      });
      const database = await import("@pstack/database/client");
      closeDatabase = database.closeDatabase;
      const { GET } = await import("../../../../apps/web/app/api/system/health/route.ts");
      const { healthCheck } = await import("../../src/health-service.ts");
      const { checkInfrastructure } = await import("../../src/infrastructure.ts");
      let probes = 0;
      const observePool = () => database.getPool().on("acquire", () => probes++);
      observePool();
      const request = async () => {
        const traceId = randomUUID();
        const response = await GET(
          new Request("http://localhost/api/system/health", { headers: { "x-trace-id": traceId } }),
        );
        const body = await response.json();
        assert.equal(body.traceId, traceId);
        assert.deepEqual(body.meta, {});
        assert.equal(body.data.service, "web");
        assert.ok(Number.isFinite(Date.parse(body.data.time)));
        return {
          status: response.status,
          health: body.data,
          cacheControl: response.headers.get("cache-control"),
        };
      };

      await t.test("concurrent and sequential requests share one observation", async () => {
        const before = probes;
        const responses = await Promise.all(Array.from({ length: 20 }, request));
        for (let i = 0; i < 20; i++) responses.push(await request());
        assert.equal(probes - before, 1);
        for (const response of responses) {
          assert.equal(response.status, 200);
          assert.equal(response.cacheControl, "no-store");
          assert.deepEqual(response.health, responses[0].health);
        }
        assert.equal(responses[0].health.status, "ok");
        assert.equal(responses[0].health.dependencies.database, "ok");
        const previousTime = responses[0].health.time;
        await pause(1100);
        const refreshed = await request();
        assert.equal(probes - before, 2);
        assert.notEqual(refreshed.health.time, previousTime);
      });

      await t.test(
        "expired healthy and degraded snapshots wait for current database state",
        async () => {
          await control.query("alter role health_user nologin");
          await closeDatabase();
          observePool();
          await pause(1100);
          const failed = await request();
          await control.query("alter role health_user login");
          assert.equal(failed.status, 503);
          assert.equal(failed.cacheControl, "no-store");
          assert.equal(failed.health.status, "degraded");
          assert.equal(failed.health.dependencies.database, "error");
          assert.deepEqual(
            await request(),
            failed,
            "degraded observations also have a short cache lifetime",
          );
          await pause(1100);
          const before = probes;
          const recovered = await request();
          assert.equal(recovered.status, 200);
          assert.equal(recovered.health.dependencies.database, "ok");
          assert.notEqual(recovered.health.time, failed.health.time);
          assert.equal(probes - before, 1);
        },
      );

      await t.test("unexpected snapshot rejection releases the in-flight slot", async (t) => {
        await pause(1100);
        const before = probes;
        t.mock.method(
          Date.prototype,
          "toISOString",
          () => {
            throw new Error("isolated health snapshot fault");
          },
          { times: 1 },
        );
        const results = await Promise.allSettled(Array.from({ length: 10 }, healthCheck));
        assert.ok(
          results.every(
            (result) =>
              result.status === "rejected" &&
              result.reason.message === "isolated health snapshot fault",
          ),
        );
        assert.equal(probes - before, 1);
        assert.equal((await request()).status, 200);
        assert.equal(probes - before, 2);
      });

      await t.test("slow probes stay single-flight and TTL starts after completion", async () => {
        await pause(1100);
        const pool = database.getPool();
        const held = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));
        const before = probes;
        const pending = [request()];
        try {
          await pause(1100);
          pending.push(...Array.from({ length: 20 }, request));
          assert.equal(
            pool.waitingCount,
            1,
            "a live probe must retain its slot beyond the cache TTL",
          );
        } finally {
          held.forEach((client) => client.release());
        }
        const responses = await Promise.all(pending);
        assert.equal(probes - before, 1);
        assert.ok(responses.every((response) => response.health.time === responses[0].health.time));
        await pause(700);
        assert.deepEqual(await request(), responses[0]);
        assert.equal(
          probes - before,
          1,
          "time spent waiting for PostgreSQL must not consume the completed TTL",
        );
        await pause(400);
        assert.notEqual((await request()).health.time, responses[0].health.time);
        assert.equal(probes - before, 2);
      });

      await t.test("CLI infrastructure probes remain uncached", async () => {
        const before = probes;
        await checkInfrastructure();
        await checkInfrastructure();
        assert.equal(probes - before, 2);
      });
    } finally {
      await closeDatabase?.();
      await control?.end();
      docker("rm", "-f", name);
    }
  },
);
