import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import { dockerCommand } from "./deployment-command.mjs";
export { dockerCommand } from "./deployment-command.mjs";

export function composeTarget(target, run = dockerCommand, direct = false) {
  const base = ["--context", target.context];
  const compose = [
    "compose",
    "--project-name",
    target.project,
    "--env-file",
    target.envFile,
    ...target.composeFiles.flatMap((file) => ["-f", file]),
    "--profile",
    "app",
    "--profile",
    "worker",
  ];
  const hostEnv = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_CONFIG", "XDG_CONFIG_HOME", "TMPDIR"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const env = (release) => ({
    ...hostEnv,
    COMPOSE_PROJECT_NAME: target.project,
    PSTACK_WEB_IMAGE: release.images.web.reference,
    PSTACK_WORKER_IMAGE: release.images.worker.reference,
    WEB_REPLICAS: String((target.replicas?.web ?? 1) * (direct ? 2 : 1)),
    PSTACK_SHARED_NETWORK: target.network ?? "",
  });
  const docker = (args) => run([...base, ...args], hostEnv);
  const command = (release, args) => run([...base, ...compose, ...args], env(release));
  async function inspectContainers() {
    const ids = (
      await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${target.project}`])
    )
      .split(/\s+/)
      .filter(Boolean);
    return ids.length ? JSON.parse(await docker(["inspect", ...ids])) : [];
  }
  async function model(release) {
    const value = JSON.parse(await command(release, ["config", "--format", "json"]));
    assert.equal(value.name, target.project, "COMPOSE_PROJECT_MISMATCH");
    for (const role of [...target.services, "migrate"]) {
      const service = value.services[role];
      assert.ok(service, "COMPOSE_SERVICE_MISSING");
      assert.ok(!service.build, "COMPOSE_BUILD_FORBIDDEN");
      assert.equal(
        service.image,
        release.images[role === "migrate" ? "web" : role].reference,
        "COMPOSE_IMAGE_MISMATCH",
      );
      assert.ok(
        !service.platform || service.platform === target.platform,
        "COMPOSE_PLATFORM_MISMATCH",
      );
    }
    validateSlotModel(value);
    assert.deepEqual(
      value.services.migrate.command,
      ["pnpm", "--filter", "@pstack/database", "db:migrate"],
      "MIGRATION_COMMAND_MISMATCH",
    );
  }
  function validateSlotModel(value) {
    if (!direct) return;
    assert.equal(
      value.services.migrate.environment?.PGOPTIONS,
      "-c lock_timeout=1000 -c statement_timeout=120000",
      "MIGRATION_TIMEOUT_REQUIRED",
    );
    for (const [name, network] of Object.entries(value.networks ?? {})) {
      assert.ok(
        network.external && network.name === target.network,
        `SLOT_NETWORK_NOT_EXTERNAL:${name}`,
      );
    }
    for (const volume of Object.values(value.volumes ?? {}))
      assert.ok(volume.external, "SLOT_VOLUME_NOT_EXTERNAL");
    for (const role of [...target.services, "migrate"]) {
      const service = value.services[role];
      assert.ok(
        !service.ports?.length && !service.container_name && !service.network_mode,
        "SLOT_NETWORK_OWNERSHIP",
      );
      assert.ok(Object.keys(service.networks ?? {}).length > 0, "SLOT_NETWORK_MISSING");
      assert.ok(!service.environment?.WORKER_ID, "FIXED_WORKER_ID_FORBIDDEN");
      for (const volume of service.volumes ?? [])
        assert.equal(volume.type, "volume", "SLOT_BIND_MOUNT_FORBIDDEN");
      if (role === "web" && target.replicas.web > 0) {
        assert.equal(
          service.environment?.WEB_REPLICAS,
          String(target.replicas.web * 2),
          "REPLICA_CONFIG_MISMATCH",
        );
        assert.equal(service.environment?.RATE_LIMIT_DRIVER, "redis", "SHARED_RATE_LIMIT_REQUIRED");
        assert.ok(
          service.environment?.UPLOAD_STORAGE_DRIVER === "s3" ||
            service.environment?.UPLOAD_STORAGE_SHARED === "true",
          "SHARED_UPLOAD_STORAGE_REQUIRED",
        );
      }
    }
  }
  async function host() {
    const contexts = JSON.parse(await docker(["context", "inspect", target.context]));
    assert.equal(contexts[0]?.Endpoints?.docker?.Host, target.endpoint, "DOCKER_CONTEXT_DRIFT");
    const info = JSON.parse(await docker(["info", "--format", "{{json .}}"]));
    const architecture =
      { aarch64: "arm64", x86_64: "amd64" }[info.Architecture] ?? info.Architecture;
    assert.equal(`${info.OSType}/${architecture}`, target.platform, "DOCKER_PLATFORM_MISMATCH");
    assert.ok(info.ID, "DOCKER_DAEMON_ID_MISSING");
    return info.ID;
  }
  async function observe(allowed, requireAll = true) {
    const all = await inspectContainers();
    const containers = all.filter(
      (container) =>
        ["web", "worker"].includes(container.Config.Labels["com.docker.compose.service"]) &&
        container.Config.Labels["com.docker.compose.oneoff"] !== "True",
    );
    for (const container of containers) {
      const role = container.Config.Labels["com.docker.compose.service"];
      assert.ok(target.services.includes(role), "UNOWNED_APPLICATION_SERVICE");
      const matching = allowed.find(
        (release) =>
          release.images[role].id === container.Image &&
          release.images[role].reference === container.Config.Image,
      );
      assert.ok(matching, "LIVE_IMAGE_DRIFT");
      const expectedHash = (await command(matching, ["config", "--hash", role]))
        .split(/\s+/)
        .at(-1);
      assert.match(expectedHash, /^[a-f0-9]{64}$/, "COMPOSE_CONFIG_HASH_MISSING");
      assert.equal(
        container.Config.Labels["com.docker.compose.config-hash"],
        expectedHash,
        "COMPOSE_CONFIGURATION_DRIFT",
      );
      assert.equal(
        container.Config.Labels["com.docker.compose.project.config_files"],
        target.composeFiles.join(","),
        "COMPOSE_FILES_DRIFT",
      );
      assert.equal(
        container.Config.Labels["com.docker.compose.project.working_dir"],
        path.dirname(target.composeFiles[0]),
        "COMPOSE_DIRECTORY_DRIFT",
      );
    }
    for (const role of target.services) {
      const matches = containers.filter(
        (container) => container.Config.Labels["com.docker.compose.service"] === role,
      );
      const count = target.replicas?.[role] ?? 1;
      const ordinals = matches.map((container) =>
        Number(container.Config.Labels["com.docker.compose.container-number"]),
      );
      assert.ok(
        !direct ||
          (new Set(ordinals).size === ordinals.length &&
            ordinals.every((n) => Number.isInteger(n) && n >= 1 && n <= count)),
        "LIVE_REPLICA_ORDINAL_DRIFT",
      );
      assert.ok(
        matches.length <= count && (!requireAll || matches.length === count),
        "LIVE_SERVICE_COUNT_DRIFT",
      );
    }
    return containers;
  }
  async function pull(release) {
    await model(release);
    for (const role of target.services) {
      const image = release.images[role];
      assert.equal(image.platform, target.platform, "RELEASE_PLATFORM_MISMATCH");
      let inspected;
      try {
        inspected = await docker(["image", "inspect", image.reference]);
      } catch {
        await docker(["pull", "--platform", target.platform, image.reference]);
        inspected = await docker(["image", "inspect", image.reference]);
      }
      const [actual] = JSON.parse(inspected);
      assert.equal(actual.Id, image.id, "PULLED_IMAGE_MISMATCH");
      assert.equal(
        `${actual.Os}/${actual.Architecture}`,
        target.platform,
        "PULLED_PLATFORM_MISMATCH",
      );
    }
  }
  async function migration(release, operation, save) {
    let jobs = (await inspectContainers()).filter(
      (container) => container.Name === `/${operation.migrationName}`,
    );
    if (!operation.migrationId) {
      assert.equal(jobs.length, 0, "MIGRATION_NAME_CONFLICT");
      // Persist intent before launching. An interruption before Docker records the job is ambiguous.
      operation.migrationId = "starting";
      await save();
      await command(release, [
        "run",
        "--detach",
        "--no-deps",
        "--name",
        operation.migrationName,
        "--label",
        `pstack.deployment.operation=${operation.id}`,
        "migrate",
      ]);
      jobs = (await inspectContainers()).filter(
        (container) => container.Name === `/${operation.migrationName}`,
      );
    }
    assert.equal(jobs.length, 1, "MIGRATION_OUTCOME_UNKNOWN");
    let job = jobs[0];
    assert.equal(
      job.Config.Labels["pstack.deployment.operation"],
      operation.id,
      "MIGRATION_OWNER_MISMATCH",
    );
    assert.equal(job.Image, release.images.web.id, "MIGRATION_IMAGE_MISMATCH");
    if (operation.migrationId !== "starting")
      assert.equal(job.Id, operation.migrationId, "MIGRATION_ID_MISMATCH");
    operation.migrationId = job.Id;
    await save();
    const deadline = Date.now() + target.timeoutSeconds * 1000;
    while (job.State.Running && Date.now() < deadline) {
      await setTimeout(1000);
      [job] = JSON.parse(await docker(["inspect", job.Id]));
    }
    assert.ok(
      !job.State.Running && job.State.Status === "exited" && job.State.ExitCode === 0,
      "MIGRATION_FAILED",
    );
  }
  async function ready(release) {
    const deadline = Date.now() + target.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const containers = await observe([release]);
      if (
        containers.every(
          (container) => container.State.Running && container.State.Health?.Status === "healthy",
        )
      ) {
        try {
          if (direct) {
            for (const container of containers) {
              const worker = container.Config.Labels["com.docker.compose.service"] === "worker";
              await docker([
                "exec",
                container.Id,
                ...(worker
                  ? [
                      "pnpm",
                      "--filter",
                      "@pstack/worker",
                      "exec",
                      "tsx",
                      "src/index.ts",
                      "health",
                      "--live",
                    ]
                  : [
                      "node",
                      "-e",
                      "fetch('http://127.0.0.1:3000/api/system/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok||(await r.json()).data?.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))",
                    ]),
              ]);
            }
            return;
          }
          const response = await fetch(target.readinessUrl, {
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          });
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            assert.ok(size <= 65536, "READINESS_RESPONSE_TOO_LARGE");
            chunks.push(chunk);
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.ok && payload.data?.status === "ok") {
            if (target.services.includes("worker"))
              await command(release, [
                "exec",
                "-T",
                "worker",
                "pnpm",
                "--filter",
                "@pstack/worker",
                "exec",
                "tsx",
                "src/index.ts",
                "health",
                "--live",
              ]);
            return;
          }
        } catch {
          /* Retry within the acceptance deadline. */
        }
      }
      await setTimeout(1000);
    }
    throw new Error("READINESS_FAILED");
  }
  return {
    host,
    command,
    docker,
    inspectContainers,
    observe,
    pull,
    migration,
    ready,
    model,
    preflight: (release) =>
      command(release, [
        "run",
        "--rm",
        "--no-deps",
        "migrate",
        "pnpm",
        "--filter",
        "@pstack/server",
        "config:check",
        "--deployment",
      ]),
    stop: (release) => command(release, ["stop", ...target.services]),
    apply: (release) =>
      command(release, [
        "up",
        "--detach",
        "--no-build",
        "--no-deps",
        ...target.services.flatMap((role) => [
          "--scale",
          `${role}=${target.replicas?.[role] ?? 1}`,
        ]),
        ...target.services,
      ]),
  };
}
