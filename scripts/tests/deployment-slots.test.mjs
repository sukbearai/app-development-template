import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeDeployment } from "../deployment-executor.mjs";
import { slotTargetSchema } from "../deployment-state.mjs";
import { fixtureVerify, writeSlotFixture } from "./deployment-slot-fixture.mjs";
import { proxyConfig } from "../deployment-proxy.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "slot-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = {
    schemaVersion: 2,
    strategy: "compose-slots",
    id: "test",
    project: "test",
    context: "default",
    endpoint: "unix:///var/run/docker.sock",
    repository: "fixture/slots",
    composeFiles: [path.join(root, "compose.json")],
    envFile: path.join(root, ".env"),
    stateDirectory: path.join(root, "state"),
    services: ["web"],
    platform: "linux/arm64",
    readinessUrl: "http://127.0.0.1:3100/health",
    timeoutSeconds: 10,
    network: "shared",
    replicas: { web: 2, worker: 0 },
    proxy: { image: `nginx:1.28-alpine@sha256:${"a".repeat(64)}`, port: 3100, drainSeconds: 10 },
  };
  await writeSlotFixture(root, target, {
    Id: `sha256:${"a".repeat(64)}`,
    reference: `fixture/web@sha256:${"a".repeat(64)}`,
  });
  const slots = {};
  let route;
  let migrations = 0;
  const runtime = {
    host: async () => "daemon",
    observe: async () => route,
    schema: async () => {},
    pull: async () => {},
    preflight: async () => {},
    migrate: async () => {
      migrations++;
    },
    start: async (release, slot) => {
      slots[slot] = release.version;
    },
    ready: async (release, slot) => {
      assert.equal(slots[slot], release.version);
    },
    route: async (slot, release, generation) => {
      route = `${slot}:${generation}`;
    },
    verifyRoute: async (active) => {
      assert.equal(route, `${active.slot}:${active.generation}`);
    },
    drain: async () => {},
    remove: async (slot) => {
      delete slots[slot];
    },
  };
  const execute = (name = "old", action = "apply", proof = async () => {}) =>
    executeDeployment({
      target,
      root,
      manifestFile: path.join(root, `${name}.json`),
      action,
      verify: fixtureVerify,
      runtime,
      proof,
    });
  return {
    root,
    target,
    execute,
    runtime,
    slots,
    migrations: () => migrations,
    route: () => route,
  };
}

test("slot rollback retains independent schema anchor and skips repeated migration", async (t) => {
  const f = await fixture(t);
  await f.execute();
  const next = await f.execute("next");
  assert.equal(next.state.current.slot, "green");
  assert.equal(next.state.schema.bundle.manifest.path, "next.json");
  const rolledBack = await f.execute("old", "rollback");
  assert.equal(rolledBack.state.current.bundle.manifest.path, "old.json");
  assert.equal(rolledBack.state.schema.bundle.manifest.path, "next.json");
  assert.equal(f.migrations(), 1);
  let anchor;
  await f.execute("next", "apply", async (options) => {
    anchor = options.schemaRelease.version;
  });
  assert.equal(anchor, "1.0.1");
});

test("failed candidate readiness restores traffic without stopping its predecessor first", async (t) => {
  const f = await fixture(t);
  await f.execute();
  const ready = f.runtime.ready;
  f.runtime.ready = (release, slot) => {
    assert.equal(f.slots.blue, "1.0.0");
    if (release.version === "1.0.1") throw new Error("READINESS_FAILED");
    return ready(release, slot);
  };
  const result = await f.execute("next");
  assert.equal(result.restored, true);
  assert.equal(result.state.current.slot, "blue");
  assert.equal(f.slots.green, undefined);
});

test("failed drain preserves candidate route and resumes only cleanup", async (t) => {
  const f = await fixture(t);
  await f.execute();
  f.runtime.drain = async () => {
    throw new Error("PROXY_DRAIN_TIMEOUT");
  };
  const result = await f.execute("next");
  assert.equal(result.failed, true);
  assert.equal(result.state.current.slot, "green");
  assert.equal(result.state.operation.retryPhase, "draining");
  f.runtime.drain = async () => {};
  const resumed = await f.execute("next", "resume");
  assert.equal(resumed.state.operation.phase, "committed");
  assert.deepEqual(f.slots, { green: "1.0.1" });
  assert.equal(f.migrations(), 1);
});

test("unknown migration outcome preserves previous serving slot and blocks automatic retry", async (t) => {
  const f = await fixture(t);
  f.runtime.migrate = async () => {
    throw new Error("MIGRATION_OUTCOME_UNKNOWN");
  };
  assert.equal((await f.execute()).state.operation.errorCode, "MIGRATION_OUTCOME_UNKNOWN");
  await assert.rejects(f.execute("old", "resume"), /INVESTIGATION/);
  assert.equal(f.route(), undefined);
});

test("slot target rejects absent workers with nonzero count and unpinned proxy", async (t) => {
  const f = await fixture(t);
  assert.equal(slotTargetSchema.safeParse(f.target).success, true);
  assert.equal(
    slotTargetSchema.safeParse({ ...f.target, replicas: { web: 2, worker: 2 } }).success,
    false,
  );
  assert.equal(
    slotTargetSchema.safeParse({ ...f.target, proxy: { ...f.target.proxy, image: "nginx:latest" } })
      .success,
    false,
  );
});

test("proxy configuration binds a generation to exact upstream addresses and trusted scheme", () => {
  const generation = "12345678-1234-1234-1234-123456789abc";
  const config = proxyConfig(
    { generation, slot: "green", addresses: ["172.20.0.2", "172.20.0.3"] },
    "https",
  );
  assert.match(config, /X-Forwarded-Proto https/);
  assert.match(config, /172\.20\.0\.2:3000/);
  assert.match(config, /172\.20\.0\.3:3000/);
  assert.match(config, new RegExp(`green:${generation}`));
  assert.doesNotMatch(config, /worker_shutdown_timeout/);
  assert.throws(() =>
    proxyConfig({ generation, slot: "green", addresses: ["127.0.0.1; return 200"] }),
  );
});

test("failed explicit rollback restores the newer predecessor with forward compatibility", async (t) => {
  const f = await fixture(t);
  await f.execute();
  await f.execute("next");
  const ready = f.runtime.ready;
  f.runtime.ready = (release, slot) => {
    if (release.version === "1.0.0") throw new Error("READINESS_FAILED");
    return ready(release, slot);
  };
  const directions = [];
  const proof = async (options) => {
    directions.push([options.release.version, options.rollback]);
    if (options.release.version === "1.0.1") {
      assert.equal(options.rollback, false);
      assert.equal(
        JSON.parse(
          await (
            await import("node:fs/promises")
          ).readFile(path.join(options.root, "next.json"), "utf8"),
        ).version,
        "1.0.1",
      );
    }
  };
  const result = await f.execute("old", "rollback", proof);
  assert.equal(result.restored, true);
  assert.equal(result.state.current.bundle.manifest.path, "next.json");
  assert.deepEqual(directions.at(-1), ["1.0.1", false]);
});
