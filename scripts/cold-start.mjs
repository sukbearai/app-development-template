#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandResult, printCommandResult } from "./engineering-command.mjs";
import { composeArgs, composeDatabaseUrl, projectName } from "./local.mjs";
import {
  checkNode,
  coldStartOptions,
  commandRunner,
  exportCheckout,
  freePort,
  isolatedEnvironment,
} from "./cold-start-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function coldStart(args = process.argv.slice(2)) {
  const runId = randomUUID();
  let output,
    runner,
    checkout,
    env,
    source,
    stage = "arguments",
    composeAttempted = false;
  let failure;
  const cleanupErrors = [];
  const steps = [];
  const secrets = [];
  let log = "",
    pendingLog = "";
  function writeDiagnostic(text) {
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    log += text;
    process.stderr.write(text);
  }
  const diagnostic = (chunk) => {
    pendingLog += chunk.toString();
    const newline = pendingLog.lastIndexOf("\n");
    if (newline >= 0) {
      writeDiagnostic(pendingLog.slice(0, newline + 1));
      pendingLog = pendingLog.slice(newline + 1);
    }
  };
  const interrupt = () => {
    if (runner) void runner.interrupt().catch(() => cleanupErrors.push("process_cleanup_failed"));
  };
  try {
    const options = coldStartOptions(args);
    if (options.help) {
      process.stdout.write(
        "Usage: node scripts/cold-start.mjs [--json]\nFresh frozen install, owned PostgreSQL and browser business smoke. Requires Node 22.12+, pnpm 10.33.4, Docker Compose and Chromium.\n",
      );
      return;
    }
    const outputRoot = path.join(root, ".verification/cold-start");
    await mkdir(outputRoot, { recursive: true });
    output = await mkdtemp(path.join(outputRoot, "run-"));
    checkNode();
    env = isolatedEnvironment();
    runner = commandRunner(root, env, diagnostic);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, interrupt);
    stage = "preflight";
    await runner.run("git", ["--version"]);
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const pnpm = await runner.run("pnpm", ["--version"]);
    if (`pnpm@${pnpm}` !== manifest.packageManager)
      throw Object.assign(new Error(`Install ${manifest.packageManager}.`), {
        code: "PNPM_VERSION_MISMATCH",
      });
    try {
      await runner.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
      await runner.run("docker", ["compose", "version"]);
    } catch (error) {
      if (["DEPENDENCY_MISSING", "INTERRUPTED"].includes(error.code)) throw error;
      throw Object.assign(
        new Error("Start Docker and install the Docker Compose plugin, then retry."),
        { code: "DOCKER_UNAVAILABLE" },
      );
    }
    checkout = await realpath(await mkdtemp(path.join(tmpdir(), "pstack-cold-start-")));
    stage = "export";
    source = await exportCheckout(root, checkout);
    if (runner.isInterrupted())
      throw Object.assign(new Error("Cold start interrupted."), { code: "INTERRUPTED" });
    runner = commandRunner(checkout, env, diagnostic);
    async function step(name, program, commandArgs) {
      stage = name;
      process.stderr.write(`cold-start: ${name}\n`);
      const started = Date.now();
      await runner.run(program, commandArgs);
      steps.push({ name, status: "passed", durationMs: Date.now() - started });
    }
    await step("git_init", "git", ["init", "--quiet"]);
    const recipe = JSON.parse(
      await readFile(path.join(checkout, "docs/startup-steps.json"), "utf8"),
    );
    await step("install", "pnpm", recipe.install);
    await step("hooks", "pnpm", recipe.hooks);
    await step("local_init", "pnpm", recipe.init);
    stage = "browser_preflight";
    try {
      await runner.run("node", [
        "--input-type=module",
        "-e",
        "import {chromium} from '@playwright/test'; const b = await chromium.launch(); await b.close();",
      ]);
    } catch (error) {
      throw Object.assign(
        new Error(
          "Chromium is unavailable. Run pnpm exec playwright install chromium; on Linux install its system dependencies with --with-deps.",
        ),
        { code: error.code === "INTERRUPTED" ? "INTERRUPTED" : "BROWSER_UNAVAILABLE" },
      );
    }
    const password = randomBytes(24).toString("hex");
    const adminPassword = randomBytes(24).toString("base64url");
    secrets.push(password, adminPassword);
    const webPort = await freePort();
    // Port zero asks Docker for an owned dynamic mapping, avoiding existing local PostgreSQL listeners.
    Object.assign(env, {
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: password,
      POSTGRES_PORT: "0",
      APP_ORIGIN: `http://127.0.0.1:${webPort}`,
      BOOTSTRAP_ADMIN_ACCOUNT: `cold_${randomBytes(5).toString("hex")}`,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      COLD_START_OUTPUT: output,
    });
    let configuration = await readFile(path.join(checkout, ".env"), "utf8");
    for (const [key, value] of Object.entries(env)) {
      if (/^(POSTGRES_|APP_ORIGIN$)/.test(key))
        configuration = configuration.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    }
    await writeFile(path.join(checkout, ".env"), configuration, { mode: 0o600 });
    stage = "local_up";
    composeAttempted = true;
    await step("local_up", "pnpm", recipe.up);
    env.COMPOSE_DATABASE_URL = composeDatabaseUrl(env);
    const prefix = composeArgs(checkout, "config").slice(0, -2);
    const mapping = await runner.run("docker", [...prefix, "port", "postgres", "5432"]);
    if (!/^127\.0\.0\.1:\d+$/.test(mapping))
      throw Object.assign(new Error("PostgreSQL must map to one loopback port."), {
        code: "UNSAFE_PORT_MAPPING",
      });
    env.DATABASE_URL = `postgres://app:${password}@${mapping}/app`;
    configuration = configuration.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${env.DATABASE_URL}`);
    await writeFile(path.join(checkout, ".env"), configuration, { mode: 0o600 });
    await step("migrate", "pnpm", recipe.migrate);
    await step("bootstrap", "pnpm", recipe.bootstrap);
    stage = "dev";
    const server = runner.launch("pnpm", [
      ...recipe.dev,
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webPort),
    ]);
    const deadline = Date.now() + 90_000;
    while (true) {
      if (runner.isInterrupted())
        throw Object.assign(new Error("Cold start interrupted."), { code: "INTERRUPTED" });
      if (server.child.exitCode !== null || server.child.signalCode !== null)
        throw Object.assign(new Error("Development server exited before readiness."), {
          code: "SERVER_EXITED",
        });
      try {
        if (
          (
            await fetch(new URL("/api/system/health", env.APP_ORIGIN), {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        )
          break;
      } catch {}
      if (Date.now() > deadline)
        throw Object.assign(new Error("Development server health timed out."), {
          code: "READINESS_TIMEOUT",
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    steps.push({ name: "dev", status: "passed" });
    await step("browser_smoke", "node", ["scripts/cold-start-smoke.mjs"]);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await runner?.stop();
    } catch {
      cleanupErrors.push("process_cleanup_failed");
    }
    if (composeAttempted) {
      try {
        env.COMPOSE_DATABASE_URL = composeDatabaseUrl(env);
        await runner.run(
          "docker",
          [...composeArgs(checkout, "down"), "--volumes", "--remove-orphans"],
          true,
        );
        for (const resource of [
          ["ps", "-aq"],
          ["volume", "ls", "-q"],
          ["network", "ls", "-q"],
        ]) {
          const remaining = await runner.run(
            "docker",
            [...resource, "--filter", `label=com.docker.compose.project=${projectName(checkout)}`],
            true,
          );
          if (remaining) throw new Error("Owned Compose resources remain after cleanup.");
        }
      } catch {
        cleanupErrors.push("compose_cleanup_failed");
      }
    }
    // Credentials and installed dependencies are temporary; evidence retains only source identity and sanitized diagnostics.
    if (checkout)
      try {
        await rm(checkout, { recursive: true, force: true });
      } catch {
        cleanupErrors.push("checkout_cleanup_failed");
      }
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, interrupt);
  }
  const interrupted = runner?.isInterrupted() || failure?.code === "INTERRUPTED";
  const status = interrupted
    ? "interrupted"
    : cleanupErrors.length
      ? "failed"
      : failure
        ? [
            "INVALID_ARGUMENT",
            "NODE_UNSUPPORTED",
            "PNPM_VERSION_MISMATCH",
            "DEPENDENCY_MISSING",
            "BROWSER_UNAVAILABLE",
            "DOCKER_UNAVAILABLE",
          ].includes(failure.code)
          ? "invalid"
          : "failed"
        : "passed";
  const result = commandResult({
    command: "cold-start",
    runId,
    status,
    errorCode: interrupted
      ? "INTERRUPTED"
      : cleanupErrors.length
        ? "CLEANUP_FAILED"
        : (failure?.code ?? (failure ? "COLD_START_FAILED" : null)),
    evidence: output ? path.relative(root, output) : null,
    data: {
      source,
      composeProject: checkout ? projectName(checkout) : null,
      steps,
      stage,
      cleanupErrors,
      message: failure?.message ?? null,
      boundary:
        "Fresh dependency install and README development startup with owned PostgreSQL; browser login, persistent role creation and logout. No optional middleware or deployment acceptance.",
    },
  });
  if (pendingLog) writeDiagnostic(pendingLog);
  if (output) {
    await writeFile(path.join(output, "run.log"), log);
    await writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  printCommandResult(result, args.includes("--json"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await coldStart();
