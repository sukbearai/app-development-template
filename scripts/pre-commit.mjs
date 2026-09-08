import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function run(command) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  await new Promise((resolve, reject) => {
    child = spawn("pnpm", [command], { cwd: snapshot, env, stdio: "inherit", shell: process.platform === "win32", detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` (exit ${code})`}`));
    });
  });
}

try {
  const dependencies = await realpath(path.join(root, "node_modules")).catch((error) => {
    if (error.code === "ENOENT") throw new Error("Missing node_modules; run pnpm install before committing.");
    throw error;
  });
  snapshot = await realpath(await mkdtemp(path.join(tmpdir(), "pstack-pre-commit-")));
  execFileSync("git", ["checkout-index", "--all", `--prefix=${snapshot}/`], { cwd: root, stdio: "inherit" });
  for (const file of ["package.json", ".oxlintrc.json", ".jscpd.json", ".jscpd-baseline.json", "scripts/check-duplication.mjs", "tools/anti-slop/src/index.ts"]) {
    await access(path.join(snapshot, file)).catch((error) => {
      throw new Error(`Required staged file missing: ${file}. Stage the quality tooling with this commit.`, { cause: error });
    });
  }
  await symlink(dependencies, path.join(snapshot, "node_modules"), "junction");
  console.log(`pre-commit: checking the staged snapshot at ${snapshot}`);
  await run("lint");
  await run("duplication:check");
} catch (error) {
  console.error(`pre-commit: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (snapshot) {
      const report = await readFile(path.join(snapshot, "artifacts/quality/duplication/jscpd-report.json"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (report) {
        const destination = path.join(root, "artifacts/quality/pre-commit", path.basename(snapshot), "jscpd-report.json");
        await mkdir(path.dirname(destination), { recursive: true });
        const parsed = JSON.parse(report);
        for (const clone of parsed.duplicates) {
          for (const file of [clone.firstFile, clone.secondFile]) file.name = path.join(root, path.relative(snapshot, file.name));
        }
        await writeFile(destination, JSON.stringify(parsed, null, 2));
        console.log(`pre-commit: staged report saved to ${destination}; line numbers refer to staged content.`);
      }
    }
  } catch (error) {
    console.error(`pre-commit: cannot preserve duplication report: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
