#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "./env.mjs";
import { run } from "./process.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function projectName(directory) {
  const label = path.basename(directory).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
  return `${label || "pstack"}-${createHash("sha256").update(directory).digest("hex").slice(0, 10)}`;
}
export function composeDatabaseUrl(env) {
  const url = new URL("postgres://postgres:5432/");
  url.username = encodeURIComponent(env.POSTGRES_USER ?? "app");
  url.password = encodeURIComponent(env.POSTGRES_PASSWORD ?? "local-development-only");
  url.pathname = "/" + encodeURIComponent(env.POSTGRES_DB ?? "app");
  if (!url.username || !url.password || url.pathname === "/") throw new Error("PostgreSQL user, password and database must be nonempty");
  return url.href;
}
export function composeArgs(directory, command, profiles = []) {
  if (!["up", "down", "status", "config", "logs", "build"].includes(command)) throw new Error("Unknown local command");
  if (profiles.some((profile) => !["app", "redis", "kafka", "storage", "analytics", "worker"].includes(profile))) throw new Error("Unknown infrastructure profile");
  const selected = new Set(profiles);
  if (selected.has("worker")) { selected.add("app"); selected.add("kafka"); }
  if (["down", "status", "logs"].includes(command)) selected.add("*");
  const args = ["compose", "--project-name", projectName(directory), "--env-file", path.join(directory, ".env"),
    "--file", path.join(directory, "deploy/compose/docker-compose.yml"), ...[...selected].flatMap((p) => ["--profile", p])];
  const actions = { up: ["up", "--detach", "--wait", "--wait-timeout", "180"], down: ["down"], status: ["ps", "--all"], config: ["config", "--quiet"], logs: ["logs", "--tail", "100"], build: ["build"] };
  return [...args, ...actions[command]];
}
async function main() {
  const [command = "status", ...profiles] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (command === "init") {
    try { await copyFile(path.join(root, ".env.example"), path.join(root, ".env"), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    console.log("Root .env ready; existing configuration was preserved");
    return;
  }
  await access(path.join(root, ".env"));
  loadEnvironment(root);
  // Project ownership is tied to this checkout. Ambient COMPOSE_PROJECT_NAME cannot target another project.
  const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName(root), COMPOSE_PROFILES: "", COMPOSE_DATABASE_URL: composeDatabaseUrl(process.env) };
  console.log(`Local project: ${env.COMPOSE_PROJECT_NAME}`);
  await run("docker", composeArgs(root, command, profiles), { cwd: root, env });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Local environment failed: ${error.message}`); process.exitCode = 1; });
}
