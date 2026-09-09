import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

async function launch(t, scenario, timeoutMs = 1500) {
  const directory = await mkdtemp(path.join(tmpdir(), "pstack-web-startup-"));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  await mkdir(path.join(directory, "dist/server"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await copyFile(
    new URL("../fixtures/web-startup.mjs", import.meta.url),
    path.join(directory, "dist/server/index.js"),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/start.mjs", import.meta.url)),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "production",
        WEB_SHUTDOWN_TIMEOUT_MS: String(timeoutMs),
        PSTACK_STARTUP_SCENARIO: scenario,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let log = "";
  const observed = new Set();
  const waiters = new Map();
  function observe(event) {
    observed.add(event);
    waiters.get(event)?.resolve();
  }
  child.on("message", observe);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      log += bytes;
      if (log.includes("Web shutdown started")) observe("stopping");
    });
  const exited = once(child, "close").then(([code, signal]) => ({ code, signal }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  async function waitFor(event) {
    if (observed.has(event)) return;
    const waiter = Promise.withResolvers();
    waiters.set(event, waiter);
    await Promise.race([
      waiter.promise,
      exited.then((result) => {
        throw new Error(`Exited before ${event}: ${JSON.stringify(result)}\n${log}`);
      }),
    ]);
  }
  await waitFor("startup");
  return {
    child,
    exited,
    waitFor,
    port,
    log: () => log,
    events: () =>
      readFile(path.join(directory, "events.txt"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    release: () => child.send("release"),
  };
}

test(
  "SIGTERM during real vinext import joins late resources and rejects new admission",
  { timeout: 10000 },
  async (t) => {
    const fixture = await launch(t, "delayed");
    fixture.child.kill("SIGTERM");
    await fixture.waitFor("stopping");
    fixture.child.kill("SIGINT");
    await delay(100);
    assert.equal(await fixture.events(), "", "Cleanup ran before startup settled");
    assert.equal(fixture.child.signalCode, null);
    let probing = true;
    const requests = (async () => {
      while (probing) {
        await fetch(`http://127.0.0.1:${fixture.port}/`, { signal: AbortSignal.timeout(100) }).then(
          (response) => {
            assert.equal(response.status, 503);
            return response.text();
          },
          () => {},
        );
        await delay(1);
      }
    })();
    try {
      fixture.release();
      assert.deepEqual(await fixture.exited, { code: 0, signal: null });
    } finally {
      probing = false;
      await requests;
    }
    assert.match(
      fixture.log(),
      /Production server running at/,
      "vinext never returned its late listening server",
    );
    assert.equal(await fixture.events(), "work-rejected\ncleanup-first\ncleanup-late\n");
  },
);

test(
  "startup rejection preserves failure through registered cleanup and signal cancellation",
  { timeout: 10000 },
  async (t) => {
    const fixture = await launch(t, "startup-and-cleanup-failure");
    fixture.child.kill("SIGTERM");
    await fixture.waitFor("stopping");
    fixture.release();
    assert.deepEqual(await fixture.exited, { code: 1, signal: null });
    assert.equal(await fixture.events(), "cleanup-first\n");
    assert.match(fixture.log(), /Web shutdown cleanup failed/);
    const result = fixture
      .log()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(result.failureCount, 2);
  },
);

test("startup failure starts cleanup without a signal", { timeout: 10000 }, async (t) => {
  const fixture = await launch(t, "startup-failure");
  fixture.release();
  assert.deepEqual(await fixture.exited, { code: 1, signal: null });
  assert.equal(await fixture.events(), "cleanup-first\n");
});

test(
  "startup and cleanup diagnostics never serialize exception secrets",
  { timeout: 10000 },
  async (t) => {
    const fixture = await launch(t, "secret-failure");
    fixture.release();
    assert.deepEqual(await fixture.exited, { code: 1, signal: null });
    assert.equal(await fixture.events(), "cleanup-first\n");
    assert.doesNotMatch(fixture.log(), /secret-sentinel|postgres:\/\//);
    assert.match(fixture.log(), /"failureCount":2/);
  },
);

for (const scenario of ["startup-hang", "cleanup-hang"]) {
  test(
    `${scenario} shares the first signal deadline across repeated signals`,
    { timeout: 10000 },
    async (t) => {
      const fixture = await launch(t, scenario, 700);
      const started = performance.now();
      fixture.child.kill("SIGTERM");
      await fixture.waitFor("stopping");
      if (scenario === "cleanup-hang") {
        await delay(250);
        fixture.release();
        await fixture.waitFor("cleanup");
      }
      await delay(scenario === "cleanup-hang" ? 150 : 400);
      fixture.child.kill("SIGTERM");
      fixture.child.kill("SIGINT");
      assert.deepEqual(await fixture.exited, { code: 1, signal: null });
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 650 && elapsed < 1050, `Deadline elapsed ${elapsed} ms`);
      assert.match(fixture.log(), /Web shutdown deadline exceeded/);
      assert.doesNotMatch(fixture.log(), /Web shutdown completed/);
      assert.equal(
        await fixture.events(),
        scenario === "startup-hang" ? "" : "work-rejected\ncleanup-first\ncleanup-late\n",
      );
    },
  );
}

test(
  "one failed disposer still attempts and awaits later cleanup exactly once",
  { timeout: 10000 },
  async (t) => {
    const fixture = await launch(t, "cleanup-failure");
    fixture.child.kill("SIGTERM");
    await fixture.waitFor("stopping");
    fixture.release();
    assert.deepEqual(await fixture.exited, { code: 1, signal: null });
    assert.equal(await fixture.events(), "work-rejected\ncleanup-first\ncleanup-late\n");
  },
);

test(
  "closed stderr cannot bypass startup joining or resource cleanup",
  { timeout: 10000 },
  async (t) => {
    const fixture = await launch(t, "delayed");
    fixture.child.stderr.destroy();
    fixture.child.kill("SIGTERM");
    await delay(100);
    assert.equal(fixture.child.exitCode, null);
    assert.equal(fixture.child.signalCode, null);
    assert.equal(await fixture.events(), "");
    fixture.release();
    assert.deepEqual(await fixture.exited, { code: 1, signal: null });
    assert.equal(await fixture.events(), "work-rejected\ncleanup-first\ncleanup-late\n");
  },
);

test("closed stderr cannot prevent the startup deadline exit", { timeout: 10000 }, async (t) => {
  const fixture = await launch(t, "startup-hang", 700);
  fixture.child.stderr.destroy();
  const started = performance.now();
  fixture.child.kill("SIGTERM");
  await delay(400);
  fixture.child.kill("SIGINT");
  assert.deepEqual(await fixture.exited, { code: 1, signal: null });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 650 && elapsed < 1050, `Closed stderr deadline elapsed ${elapsed} ms`);
});
