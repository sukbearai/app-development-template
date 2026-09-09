import { execFileSync, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const env = { ...process.env };
for (const key of git("rev-parse", "--local-env-vars").split("\n")) delete env[key];
let snapshot;
let child;
let interrupted;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const stop = (signal) => {
  interrupted = signal;
  if (child?.pid) {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  }
};
const handlers = new Map(signals.map((signal) => [signal, () => stop(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);

async function linkDependencies(directory, installed, workspaces) {
  const targets = new Map();
  const entries = await readdir(installed).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries) {
    if (name.startsWith("@")) {
      for (const member of await readdir(path.join(installed, name)))
        targets.set(`${name}/${member}`, path.join(installed, name, member));
    } else targets.set(name, path.join(installed, name));
  }
  for (const [name, target] of targets) {
    const resolved = await realpath(target);
    const relative = path.relative(root, resolved);
    if (
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.split(path.sep).includes("node_modules")
    ) {
      const staged = workspaces.get(name);
      if (staged === path.join(snapshot, relative)) targets.set(name, staged);
      else targets.delete(name);
    }
  }
  await mkdir(directory, { recursive: true });
  for (const [name, target] of targets) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(target, destination, (await stat(target)).isDirectory() ? "junction" : "file");
  }
}

async function run(command) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  await new Promise((resolve, reject) => {
    child = spawn("pnpm", [command], {
      cwd: snapshot,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` (exit ${code})`}`));
    });
  });
}

async function preserveReports() {
  for (const report of [
    {
      source: "dependencies/report.json",
      filename: "dependency-report.json",
      label: "staged dependency report",
      rewritePaths: false,
    },
    {
      source: "duplication/jscpd-report.json",
      filename: "jscpd-report.json",
      label: "staged report",
      rewritePaths: true,
    },
  ]) {
    try {
      let contents = await readFile(path.join(snapshot, "artifacts/quality", report.source)).catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (contents === null) continue;
      const parsed = JSON.parse(contents.toString("utf8"));
      if (report.rewritePaths) {
        for (const clone of parsed.duplicates) {
          for (const file of [clone.firstFile, clone.secondFile])
            file.name = path.join(root, path.relative(snapshot, file.name));
        }
        contents = JSON.stringify(parsed, null, 2);
      }
      const destination = path.join(
        root,
        "artifacts/quality/pre-commit",
        path.basename(snapshot),
        report.filename,
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
      const suffix = report.rewritePaths ? "; line numbers refer to staged content." : "";
      console.log(`pre-commit: ${report.label} saved to ${destination}${suffix}`);
    } catch (error) {
      console.error(`pre-commit: cannot preserve quality report: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

try {
  const dependencies = await realpath(path.join(root, "node_modules")).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error("Missing node_modules; run pnpm install before committing.");
    throw error;
  });
  snapshot = await realpath(await mkdtemp(path.join(tmpdir(), "pstack-pre-commit-")));
  execFileSync("git", ["checkout-index", "--all", `--prefix=${snapshot}/`], {
    cwd: root,
    stdio: "inherit",
  });
  for (const file of [
    "package.json",
    ".oxlintrc.json",
    ".jscpd.json",
    ".jscpd-baseline.json",
    "scripts/check-duplication.mjs",
    "scripts/check-dependencies.mjs",
    "scripts/source-scope.mjs",
    "scripts/source-scope.json",
    "tools/anti-slop/src/index.ts",
  ]) {
    await access(path.join(snapshot, file)).catch((error) => {
      throw new Error(
        `Required staged file missing: ${file}. Stage the quality tooling with this commit.`,
        { cause: error },
      );
    });
  }
  const workspaces = new Map();
  const directories = [];
  for (const parent of ["apps", "packages", "services"]) {
    for (const entry of await readdir(path.join(snapshot, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = path.join(parent, entry.name);
      const directory = path.join(snapshot, relative);
      directories.push(relative);
      const manifest = await readFile(path.join(directory, "package.json"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (manifest) workspaces.set(JSON.parse(manifest).name, directory);
    }
  }
  await linkDependencies(path.join(snapshot, "node_modules"), dependencies, workspaces);
  for (const directory of directories)
    await linkDependencies(
      path.join(snapshot, directory, "node_modules"),
      path.join(root, directory, "node_modules"),
      workspaces,
    );
  console.log(`pre-commit: checking the staged snapshot at ${snapshot}`);
  await run("lint");
  await run("duplication:check");
  await run("dependency:check");
} catch (error) {
  console.error(`pre-commit: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (snapshot) await preserveReports();
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
