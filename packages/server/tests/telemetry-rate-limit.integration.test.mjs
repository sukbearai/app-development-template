import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

const workspace = path.resolve(import.meta.dirname, "../../..");
const execute = promisify(execFile);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const routeProcess = `
  import { POST as telemetry } from './apps/web/app/api/telemetry/route.ts';
  import { POST as login } from './apps/web/app/api/auth/login/route.ts';
  import { closeDatabase } from './packages/database/src/client.ts';
  import { closeRedis } from './packages/server/src/redis-client.ts';
  const results = [];
  try {
    for (const [index, action] of JSON.parse(process.env.TEST_ACTIONS).entries()) {
      let reads = 0;
      const payload = action.login
        ? { account: 'nonexistent-test-account', password: 'invalid-test-password' }
        : { event: 'rate-limit-regression', payload: {} };
      const stream = new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const request = new Request('http://localhost' + (action.login ? '/api/auth/login' : '/api/telemetry'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-trace-id': process.env.TEST_TRACE_PREFIX + ':' + index,
          ...(action.spoof ? { 'x-forwarded-for': '198.51.100.' + index } : {}),
        },
        body: stream,
        duplex: 'half',
      });
      const response = await (action.login ? login : telemetry)(request);
      results.push({ status: response.status, body: await response.json(), reads });
    }
    process.stdout.write(JSON.stringify(results));
  } finally {
    await closeRedis();
    await closeDatabase();
  }
`;

test("anonymous telemetry enforces its global budget before body reads and durable writes", { timeout: 120000 }, async (t) => {
  const databaseName = `pstack-telemetry-db-${randomUUID()}`;
  const redisName = `pstack-telemetry-redis-${randomUUID()}`;
  let pool;
  try {
    docker("run", "-d", "--rm", "--name", databaseName, "-e", "POSTGRES_PASSWORD=isolated-test-only", "-e", "POSTGRES_DB=pstack_test", "-p", "127.0.0.1::5432", "postgres:17-bullseye");
    docker("run", "-d", "--name", redisName, "-p", "127.0.0.1::6379", "redis:5.0.8");
    const databasePort = docker("port", databaseName, "5432/tcp").split(":").at(-1);
    const redisPort = docker("port", redisName, "6379/tcp").split(":").at(-1);
    const databaseUrl = `postgres://postgres:isolated-test-only@127.0.0.1:${databasePort}/pstack_test`;
    pool = new pg.Pool({ connectionString: databaseUrl });
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await pool.query("select 1");
        assert.equal(docker("exec", redisName, "redis-cli", "ping"), "PONG");
        break;
      } catch (error) {
        if (attempt === 59) throw error;
        await pause(100);
      }
    }
    const baseEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      RATE_LIMIT_DRIVER: "memory",
      WEB_REPLICAS: "1",
      LOGIN_RATE_LIMIT_MAX: "20",
      LOGIN_RATE_LIMIT_GLOBAL_MAX: "1",
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: "60",
    };
    execFileSync("pnpm", ["--filter", "@pstack/database", "db:migrate"], { cwd: workspace, env: baseEnv, stdio: "pipe" });
    const run = async (actions, extra = {}) => {
      const prefix = randomUUID();
      const result = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", routeProcess], {
        cwd: workspace,
        env: { ...baseEnv, ...extra, TEST_ACTIONS: JSON.stringify(actions), TEST_TRACE_PREFIX: prefix },
        timeout: 30000,
      });
      const rows = await pool.query(
        "select (select count(*)::int from app_telemetry_events where trace_id like $1) telemetry, (select count(*)::int from app_outbox_events where trace_id like $1) outbox",
        [prefix + ":%"],
      );
      return { responses: JSON.parse(result.stdout), counts: rows.rows[0] };
    };
    const assertLimited = (result) => {
      assert.equal(result.status, 429);
      assert.equal(result.body.error.code, "RATE_LIMITED");
      assert.ok(result.body.error.details.retryAfterSeconds > 0);
      assert.equal(result.reads, 0, "rejected request body must remain unread");
    };

    const burst = (count) => Array.from({ length: count }, (_, index) => ({ spoof: index % 2 === 0 }));
    await t.test("memory accepts 120 requests and rejects request 121 without writing", async () => {
      const result = await run(burst(121));
      assert.deepEqual(result.responses.map(response => response.status), [...Array(120).fill(201), 429]);
      assertLimited(result.responses[120]);
      assert.deepEqual(result.counts, { telemetry: 120, outbox: 120 });
    });

    await t.test("login and telemetry retain independent budgets in either order", async () => {
      const loginFirst = await run([{ login: true }, { login: true }, ...burst(121)]);
      assert.deepEqual(loginFirst.responses.map(response => response.status), [401, 429, ...Array(120).fill(201), 429]);
      assertLimited(loginFirst.responses[1]);
      assertLimited(loginFirst.responses[122]);
      assert.deepEqual(loginFirst.counts, { telemetry: 120, outbox: 120 });
      const telemetryFirst = await run([...burst(121), { login: true }, { login: true }]);
      assert.deepEqual(telemetryFirst.responses.map(response => response.status), [...Array(120).fill(201), 429, 401, 429]);
      assertLimited(telemetryFirst.responses[120]);
      assertLimited(telemetryFirst.responses[122]);
      assert.deepEqual(telemetryFirst.counts, { telemetry: 120, outbox: 120 });
    });

    await t.test("two Web processes share 120 Redis admissions despite missing cookies and forged forwarding addresses", async () => {
      const config = { RATE_LIMIT_DRIVER: "redis", WEB_REPLICAS: "2", REDIS_URL: `redis://127.0.0.1:${redisPort}/7` };
      const results = await Promise.all([run(burst(70), config), run(burst(70), config)]);
      const responses = results.flatMap(result => result.responses);
      assert.equal(responses.filter(response => response.status === 201).length, 120);
      const rejected = responses.filter(response => response.status === 429);
      assert.equal(rejected.length, 20);
      rejected.forEach(assertLimited);
      assert.equal(results.reduce((count, result) => count + result.counts.telemetry, 0), 120);
      assert.equal(results.reduce((count, result) => count + result.counts.outbox, 0), 120);
    });

    await t.test("Redis outage fails closed before body consumption or writes", async () => {
      docker("stop", redisName);
      const result = await run([{}], { RATE_LIMIT_DRIVER: "redis", WEB_REPLICAS: "2", REDIS_URL: `redis://127.0.0.1:${redisPort}/7` });
      assert.ok(result.responses[0].status >= 500);
      assert.equal(result.responses[0].reads, 0);
      assert.deepEqual(result.counts, { telemetry: 0, outbox: 0 });
    });
  } finally {
    await pool?.end();
    for (const name of [redisName, databaseName]) {
      try { docker("rm", "-f", name); } catch {}
    }
  }
});
