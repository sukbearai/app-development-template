import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import { dockerCommand } from "./deployment-command.mjs";
export { dockerCommand } from "./deployment-command.mjs";

export function composeTarget(target, run = dockerCommand) {
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
    assert.deepEqual(
      value.services.migrate.command,
      ["pnpm", "--filter", "@pstack/database", "db:migrate"],
      "MIGRATION_COMMAND_MISMATCH",
    );
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
      assert.ok(
        matches.length <= 1 && (!requireAll || matches.length === 1),
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
      await docker(["pull", "--platform", target.platform, image.reference]);
      const [actual] = JSON.parse(await docker(["image", "inspect", image.reference]));
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
      command(release, ["up", "--detach", "--no-build", "--no-deps", ...target.services]),
  };
}
