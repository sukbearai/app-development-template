import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { rehearsalOperation } from "./published-deployment-support.mjs";
import { setTimeout } from "node:timers/promises";
import { createTestTrpcClient } from "./trpc-client.mjs";
import { trustedFetch } from "./published-deployment-target.mjs";

export async function untilReady(operation, signal) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      if (await operation()) return;
    } catch {
      signal.throwIfAborted();
    }
    await setTimeout(1000, undefined, { signal });
  }
  throw new Error("REHEARSAL_READINESS_TIMEOUT");
}

export function rehearsalChecks(setup, runtime, signal) {
  const { origin, adminPassword, ca } = setup;
  const fetch = trustedFetch(ca);
  const roles = [];
  const uploads = [];
  const tasks = [];
  const sql = (release, query) =>
    runtime.command(release, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "app",
      "-d",
      "app",
      "-At",
      "-c",
      query,
    ]);
  const ledger = async (release) =>
    JSON.parse(
      await sql(
        release,
        "SELECT coalesce(json_agg(json_build_object('hash',hash,'createdAt',created_at) ORDER BY created_at),'[]'::json) FROM drizzle.drizzle_migrations",
      ),
    );
  async function infrastructure() {
    const containers = (await runtime.inspectContainers()).filter((container) =>
      ["postgres", "kafka", "ingress"].includes(
        container.Config.Labels["com.docker.compose.service"],
      ),
    );
    assert.equal(containers.length, 3);
    assert.ok(containers.every((container) => container.State.Running));
    const volumes = JSON.parse(
      await runtime.docker([
        "volume",
        "inspect",
        ...["database", "kafka-data", "uploads"].map((name) => `${setup.target.project}_${name}`),
      ]),
    );
    return {
      containers: containers
        .map((container) => ({
          id: container.Id,
          service: container.Config.Labels["com.docker.compose.service"],
          startedAt: container.State.StartedAt,
          restarts: container.RestartCount,
        }))
        .sort((a, b) => a.service.localeCompare(b.service)),
      volumes: volumes
        .map((volume) => ({
          name: volume.Name,
          createdAt: volume.CreatedAt,
          mountpoint: volume.Mountpoint,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  async function business(release, marker, create = true) {
    const token = (
      await createTestTrpcClient({ baseUrl: origin, fetch }).auth.login.mutate({
        account: "admin",
        password: adminPassword,
      })
    ).token;
    const client = createTestTrpcClient({
      baseUrl: origin,
      fetch,
      headers: { authorization: `Bearer ${token}` },
    });
    const existing = await client.roles.list.query();
    for (const id of roles)
      assert.ok(
        existing.some((role) => role.id === id),
        "Role did not survive deployment",
      );
    for (const upload of uploads) {
      assert.equal(
        await sql(
          release,
          `SELECT count(*) FROM app_file_assets WHERE id='${upload.id}' AND storage_key='${upload.storageKey}'`,
        ),
        "1",
        "Upload metadata was lost",
      );
      assert.equal(
        await runtime.command(release, [
          "exec",
          "-T",
          "web",
          "cat",
          path.posix.join("/app/uploads", upload.storageKey),
        ]),
        upload.content,
        "Upload bytes were lost",
      );
    }
    if (create) {
      const id = `published_${marker}`;
      await client.roles.create.mutate({
        id,
        name: id,
        permissionIds: ["admin.read"],
        status: "active",
      });
      roles.push(id);
      const content = `persisted-public-release-${marker}`;
      const form = new FormData();
      form.set("file", new File([content], `${marker}.txt`, { type: "text/plain" }));
      const response = await fetch(`${origin}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const upload = (await response.json()).data;
      assert.match(upload.id, /^[a-zA-Z0-9_-]+$/);
      assert.match(upload.storageKey, /^[a-zA-Z0-9_./-]+$/);
      assert.ok(
        !upload.storageKey.split("/").includes("..") && !path.posix.isAbsolute(upload.storageKey),
      );
      uploads.push({ id: upload.id, storageKey: upload.storageKey, content });
    }
    const task = randomBytes(16).toString("hex");
    await sql(
      release,
      `INSERT INTO app_outbox_events(id,topic,event_type,trace_id,payload) VALUES('${task}','app.tasks','demo.echo','${task}','{"marker":"${task}"}'::jsonb)`,
    );
    tasks.push(task);
    await untilReady(
      async () =>
        (await sql(
          release,
          `SELECT count(*) FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'='${task}'`,
        )) === "1",
      signal,
    );
    for (const prior of tasks)
      assert.equal(
        await sql(
          release,
          `SELECT count(*) FROM app_async_receipts WHERE event_type='demo.echo' AND result->'value'->>'marker'='${prior}'`,
        ),
        "1",
        "Task receipt was lost or duplicated",
      );
    return {
      roles: [...roles],
      uploadIds: uploads.map((upload) => upload.id),
      completedTaskIds: [...tasks],
    };
  }
  return { sql, ledger, infrastructure, business };
}

export async function rehearsalFailureSnapshot(target, runtime, releases) {
  const snapshot = { operation: null, containers: [], observationErrors: [] };
  try {
    const state = JSON.parse(
      await readFile(path.join(target.stateDirectory, "state.json"), "utf8"),
    );
    snapshot.operation = rehearsalOperation(state.operation);
  } catch {
    snapshot.observationErrors.push("DEPLOYMENT_STATE_UNAVAILABLE");
  }
  try {
    for (const container of await runtime.inspectContainers()) {
      const labels = container.Config.Labels;
      const service = labels["com.docker.compose.service"];
      if (!["web", "worker", "migrate", "postgres", "kafka", "ingress"].includes(service)) continue;
      const hash = (value) => (/^[a-f0-9]{64}$/.test(value ?? "") ? value : null);
      const observed = {
        id: hash(container.Id),
        service,
        status: [
          "created",
          "running",
          "paused",
          "restarting",
          "removing",
          "exited",
          "dead",
        ].includes(container.State.Status)
          ? container.State.Status
          : null,
        running: container.State.Running === true,
        exitCode: Number.isInteger(container.State.ExitCode) ? container.State.ExitCode : null,
        health: ["starting", "healthy", "unhealthy"].includes(container.State.Health?.Status)
          ? container.State.Health.Status
          : null,
        configHash: hash(labels["com.docker.compose.config-hash"]),
        expectedConfigHash: null,
      };
      if (["web", "worker"].includes(service)) {
        const release = releases.find(
          (entry) =>
            entry.images[service].id === container.Image &&
            entry.images[service].reference === container.Config.Image,
        );
        if (release) {
          try {
            observed.expectedConfigHash = hash(
              (await runtime.command(release, ["config", "--hash", service])).split(/\s+/).at(-1),
            );
            if (observed.expectedConfigHash && observed.configHash !== observed.expectedConfigHash)
              snapshot.observationErrors.push(`COMPOSE_CONFIGURATION_DRIFT:${service}`);
          } catch {
            snapshot.observationErrors.push(`COMPOSE_HASH_UNAVAILABLE:${service}`);
          }
        }
      }
      snapshot.containers.push(observed);
    }
  } catch {
    snapshot.observationErrors.push("CONTAINER_SNAPSHOT_UNAVAILABLE");
  }
  return snapshot;
}
