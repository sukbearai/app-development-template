import { execFileSync, spawnSync } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

try {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (configured.error) throw configured.error;
  if (configured.status !== 0 && configured.status !== 1) throw new Error(configured.stderr);
  const hooksPath = configured.stdout.trim();
  if (configured.status === 0 && path.resolve(root, hooksPath) !== path.join(root, ".githooks")) {
    throw new Error(`Existing core.hooksPath=${JSON.stringify(hooksPath)}; integrate or remove that hook configuration explicitly before installing.`);
  }
  if (configured.status === 1) {
    const directory = path.resolve(root, git("rev-parse", "--git-common-dir"), "hooks");
    const existing = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    const foreign = existing.filter((entry) => !entry.name.endsWith(".sample"));
    if (foreign.length) throw new Error(`Existing hooks at ${directory}: ${foreign.map((entry) => entry.name).join(", ")}; integrate or remove them explicitly before installing.`);
  }
  await chmod(path.join(root, ".githooks/pre-commit"), 0o755);
  git("config", "--local", "core.hooksPath", ".githooks");
  console.log("Installed local Git hooks from .githooks. Commits check the staged snapshot.");
} catch (error) {
  console.error(`hooks:install: ${error.message}`);
  process.exitCode = 1;
}
