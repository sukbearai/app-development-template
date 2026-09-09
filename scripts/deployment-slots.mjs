import assert from "node:assert/strict";
import { composeTarget, dockerCommand } from "./deployment-compose.mjs";
import { deploymentProxy } from "./deployment-proxy.mjs";

export function slotRuntime(target, run = dockerCommand) {
  const slots = Object.fromEntries(
    ["blue", "green"].map((slot) => [
      slot,
      composeTarget({ ...target, project: `${target.project}-${slot}` }, run, true),
    ]),
  );
  const docker = slots.blue.docker;
  const proxy = deploymentProxy(target, docker);
  async function observe(releases) {
    for (const slot of ["blue", "green"]) {
      const release = releases[slot];
      await slots[slot].observe(release ? [release] : [], false);
    }
    if (Object.keys(releases).length === 0)
      assert.equal(await proxy.inspect(), null, "UNRECORDED_PROXY");
    return proxy.observed();
  }
  async function remove(slot, release) {
    const runtime = slots[slot];
    const containers = await runtime.observe([release], false);
    if (containers.length) {
      await docker(["stop", ...containers.map((container) => container.Id)]);
      await docker(["rm", ...containers.map((container) => container.Id)]);
    }
    assert.equal((await runtime.observe([], false)).length, 0, "SLOT_CLEANUP_FAILED");
  }
  async function routeFor(slot, release, generation) {
    const containers = await slots[slot].observe([release]);
    const addresses = containers
      .filter((container) => container.Config.Labels["com.docker.compose.service"] === "web")
      .map((container) => container.NetworkSettings.Networks[target.network]?.IPAddress)
      .sort();
    assert.ok(addresses.every(Boolean), "SLOT_ADDRESS_MISSING");
    return { slot, generation, addresses };
  }
  async function schema(release, ledger) {
    const { liveSchemaCommand } = await import("./migration-compatibility.mjs");
    await slots.blue.command(release, [
      "run",
      "--rm",
      "--no-deps",
      "migrate",
      ...liveSchemaCommand(ledger),
    ]);
  }
  return {
    host: slots.blue.host,
    observe,
    schema,
    pull: (release, slot) => slots[slot].pull(release),
    preflight: (release, slot) => slots[slot].preflight(release),
    migrate: (release, slot, operation, save) => slots[slot].migration(release, operation, save),
    start: (release, slot) => slots[slot].apply(release),
    ready: (release, slot) => slots[slot].ready(release),
    remove,
    route: async (slot, release, generation) =>
      proxy.switchTo(await routeFor(slot, release, generation)),
    verifyRoute: async (active, release) => {
      const route = await routeFor(active.slot, release, active.generation);
      await proxy.verify(route);
      const response = await fetch(target.readinessUrl, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        headers: { connection: "close" },
      });
      assert.ok(
        response.ok && response.headers.get("x-pstack-generation") === active.generation,
        "PUBLIC_ROUTE_MISMATCH",
      );
      assert.ok(
        route.addresses.some(
          (address) => response.headers.get("x-pstack-upstream") === `${address}:3000`,
        ),
        "PUBLIC_UPSTREAM_DRIFT",
      );
      assert.equal((await response.json()).data?.status, "ok", "PUBLIC_READINESS_FAILED");
    },
    drain: proxy.drain,
  };
}
