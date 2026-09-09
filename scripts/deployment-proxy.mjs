import assert from "node:assert/strict";
import { readFile, rename, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { atomicJson, privateDirectory } from "./deployment-state.mjs";
import { sha256 } from "./verification-evidence.mjs";

export function proxyConfig(route, protocol = "http") {
  assert.ok(["http", "https"].includes(protocol));
  assert.match(route.generation, /^[a-f0-9-]{36}$/);
  assert.ok(["blue", "green"].includes(route.slot));
  assert.ok(route.addresses.length > 0);
  for (const address of route.addresses) assert.match(address, /^(\d{1,3}\.){3}\d{1,3}$/);
  return `worker_processes 2;
pid /tmp/nginx.pid;
events { worker_connections 2048; }
http {
  access_log off;
  upstream application { ${route.addresses.map((address) => `server ${address}:3000 max_fails=1 fail_timeout=2s;`).join(" ")} }
  server {
    listen 8080;
    add_header X-Pstack-Generation "${route.generation}" always;
    add_header X-Pstack-Upstream $upstream_addr always;
    location = /__pstack/route { return 200 '${route.slot}:${route.generation}'; }
    location / {
      proxy_pass http://application;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto ${protocol};
      proxy_set_header Connection "";
      proxy_read_timeout 900s;
      client_max_body_size 0;
      proxy_next_upstream error timeout;
    }
  }
}
`;
}
export function deploymentProxy(target, docker) {
  const directory = path.join(target.stateDirectory, "proxy");
  const name = `${target.project}-proxy`;
  const configFile = path.join(directory, "current.conf");
  const routeFile = path.join(directory, "route.json");
  async function inspect() {
    const ids = (await docker(["ps", "-aq", "--filter", `name=^/${name}$`]))
      .split(/\s+/)
      .filter(Boolean);
    if (!ids.length) return null;
    assert.equal(ids.length, 1, "PROXY_COUNT_DRIFT");
    const [container] = JSON.parse(await docker(["inspect", ids[0]]));
    assert.equal(
      container.Config.Labels["pstack.deployment.target"],
      target.id,
      "PROXY_OWNER_MISMATCH",
    );
    assert.equal(container.Config.Image, target.proxy.image, "PROXY_IMAGE_DRIFT");
    assert.deepEqual(
      container.Config.Cmd,
      ["nginx", "-g", "daemon off;", "-c", "/etc/nginx/pstack.conf"],
      "PROXY_COMMAND_DRIFT",
    );
    assert.ok(!container.HostConfig.Binds?.length, "PROXY_MOUNT_DRIFT");
    assert.deepEqual(
      Object.keys(container.NetworkSettings.Networks),
      [target.network],
      "PROXY_NETWORK_DRIFT",
    );
    assert.deepEqual(
      container.HostConfig.PortBindings,
      { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(target.proxy.port) }] },
      "PROXY_PORT_DRIFT",
    );
    return container;
  }
  async function readRoute() {
    try {
      return JSON.parse(await readFile(routeFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function observed() {
    const container = await inspect();
    if (!container?.State.Running) return null;
    const response = await fetch(`http://127.0.0.1:${target.proxy.port}/__pstack/route`, {
      signal: AbortSignal.timeout(3000),
      headers: { connection: "close" },
      redirect: "error",
    });
    assert.ok(response.ok, "PROXY_OBSERVATION_FAILED");
    const value = await response.text();
    assert.match(value, /^(blue|green):[a-f0-9-]{36}$/);
    return value;
  }
  async function verify(route) {
    const container = await inspect();
    assert.ok(container?.State.Running, "PROXY_NOT_RUNNING");
    const expected = sha256(proxyConfig(route, new URL(target.readinessUrl).protocol.slice(0, -1)));
    const actual = (
      await docker(["exec", container.Id, "sha256sum", "/etc/nginx/pstack.conf"])
    ).split(/\s+/)[0];
    assert.equal(actual, expected, "PROXY_CONFIGURATION_DRIFT");
    const saved = await readRoute();
    assert.ok(
      saved &&
        saved.sha256 === expected &&
        saved.generation === route.generation &&
        saved.slot === route.slot,
      "PROXY_ROUTE_DRIFT",
    );
    const seen = new Set();
    const deadline = Date.now() + target.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if ((await observed()) === `${route.slot}:${route.generation}`) {
        const response = await fetch(`http://127.0.0.1:${target.proxy.port}/api/system/health`, {
          signal: AbortSignal.timeout(3000),
          headers: { connection: "close" },
          redirect: "error",
        });
        if (response.headers.get("x-pstack-generation") !== route.generation) {
          await response.body?.cancel();
          continue;
        }
        const upstream = response.headers.get("x-pstack-upstream");
        assert.ok(
          route.addresses.some((address) => upstream === `${address}:3000`),
          "PROXY_UPSTREAM_DRIFT",
        );
        assert.ok(
          response.ok && (await response.json()).data?.status === "ok",
          "PROXY_UPSTREAM_NOT_READY",
        );
        seen.add(upstream);
        if (seen.size === route.addresses.length) return;
      }
      await setTimeout(100);
    }
    throw new Error("PROXY_GENERATION_MISMATCH");
  }
  async function workers(container) {
    const value = await docker([
      "exec",
      container.Id,
      "sh",
      "-c",
      "ps -o pid,args | awk '/nginx: worker process/ && !/awk/ {print $1}'",
    ]);
    return value.split(/\s+/).filter(Boolean);
  }
  async function switchTo(route) {
    await privateDirectory(directory);
    const config = proxyConfig(route, new URL(target.readinessUrl).protocol.slice(0, -1));
    const prior = await readRoute();
    let container = await inspect();
    if (prior?.generation === route.generation) {
      assert.equal(prior.sha256, sha256(config), "PROXY_ROUTE_DRIFT");
      if ((await observed()) === `${route.slot}:${route.generation}`) {
        await verify(route);
        return;
      }
    }
    const pending = path.join(directory, "candidate.conf");
    const handle = await open(pending, "w", 0o600);
    try {
      await handle.writeFile(config);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const retiring =
      prior?.generation === route.generation
        ? prior.retiring
        : container?.State.Running
          ? await workers(container)
          : [];
    await atomicJson(routeFile, {
      ...route,
      sha256: sha256(config),
      retiring,
      containerId: container?.Id ?? null,
    });
    if (!container) {
      await docker([
        "create",
        "--name",
        name,
        "--label",
        `pstack.deployment.target=${target.id}`,
        "--network",
        target.network,
        "--publish",
        `127.0.0.1:${target.proxy.port}:8080`,
        "--restart",
        "unless-stopped",
        target.proxy.image,
        "nginx",
        "-g",
        "daemon off;",
        "-c",
        "/etc/nginx/pstack.conf",
      ]);
      container = await inspect();
    }
    if (container.State.Running) {
      await docker(["cp", pending, `${container.Id}:/etc/nginx/pstack.next`]);
      await docker(["exec", container.Id, "nginx", "-t", "-c", "/etc/nginx/pstack.next"]);
      await docker([
        "exec",
        container.Id,
        "mv",
        "/etc/nginx/pstack.next",
        "/etc/nginx/pstack.conf",
      ]);
      await docker(["exec", container.Id, "nginx", "-s", "reload", "-c", "/etc/nginx/pstack.conf"]);
    } else {
      await docker(["cp", pending, `${container.Id}:/etc/nginx/pstack.conf`]);
      await docker(["start", container.Id]);
    }
    await rename(pending, configFile);
    const folder = await open(directory, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
    await verify(route);
  }
  async function drain() {
    const route = await readRoute();
    assert.ok(route, "PROXY_ROUTE_MISSING");
    const container = await inspect();
    assert.ok(container?.State.Running, "PROXY_NOT_RUNNING");
    if (route.containerId !== container.Id) return;
    const deadline = Date.now() + target.proxy.drainSeconds * 1000;
    while (Date.now() < deadline) {
      const live = await workers(container);
      if (route.retiring.every((pid) => !live.includes(pid))) return;
      await setTimeout(100);
    }
    throw new Error("PROXY_DRAIN_TIMEOUT");
  }
  return { inspect, observed, verify, switchTo, drain };
}
