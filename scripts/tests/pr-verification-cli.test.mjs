import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
  symlink,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
async function interruptionFixture(t, duringRelease = false) {
  const root = await mkdtemp(path.join(tmpdir(), "verification-interrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "bin"));
  await symlink(path.join(project, "node_modules"), path.join(root, "node_modules"));
  for (const file of [
    "pr-verify.mjs",
    "process.mjs",
    "engineering-command.mjs",
    "verification-evidence.mjs",
    "verification-plan.mjs",
    "verification-scheduler.mjs",
    "gate-reports.mjs",
  ])
    await copyFile(path.join(project, "scripts", file), path.join(root, "scripts", file));
  await writeFile(
    path.join(root, "scripts/generate-sdk.mjs"),
    "process.stdout.write(process.env.PSTACK_VERIFICATION_ROOT + '\\n');\n",
  );
  await writeFile(path.join(root, ".gitignore"), "artifacts/\n.verification/\nnode_modules\n");
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const binary = path.join(root, "bin/pnpm");
  await writeFile(
    binary,
    `#!${process.execPath}\nprocess.stdout.write(process.env.PSTACK_VERIFICATION_ROOT + '\\n');\nif(process.argv[2]==='build'){process.kill(process.ppid,'SIGINT');setTimeout(()=>{},30);}\n`,
  );
  await chmod(binary, 0o755);
  await writeFile(
    path.join(root, "scripts/interrupt-release.mjs"),
    `
import { rm, readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { runVerification, parseArguments } from "./pr-verify.mjs";
await runVerification(parseArguments(["--json"]), {
  release: async (lock) => {
    assert.equal(JSON.parse(await readFile("artifacts/pr-verify/summary.json", "utf8")).passed, true);
    const [run] = await readdir("artifacts/verification");
    assert.equal(JSON.parse(await readFile("artifacts/verification/" + run + "/index.json", "utf8")).status, "passed");
    process.kill(process.pid, "SIGINT");
    await setImmediate();
    process.kill(process.pid, "SIGINT");
    await setImmediate();
    await rm(lock, { recursive: true, force: true });
  },
});
`,
  );
  if (duringRelease)
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdout.write(process.env.PSTACK_VERIFICATION_ROOT + '\\n');\n`,
    );
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("add", ".");
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const child = spawn(
    process.execPath,
    [duringRelease ? "scripts/interrupt-release.mjs" : "scripts/pr-verify.mjs", "--json"],
    {
      cwd: root,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 130);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "interrupted");
  assert.equal(result.errorCode, "verification_failed");
  const index = JSON.parse(await readFile(path.join(root, result.evidence), "utf8"));
  assert.equal(index.status, "failed");
  assert.equal(
    index.checks.find((check) => check.name === "build").status,
    duringRelease ? "passed" : "failed",
  );
  const summary = JSON.parse(
    await readFile(path.join(root, "artifacts/pr-verify/summary.json"), "utf8"),
  );
  assert.equal(summary.passed, false);
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(index.checks.length, 14);
  for (const check of index.checks.filter((item) => item.status === "passed")) {
    const log = await readFile(path.join(root, check.evidence[0].path), "utf8");
    assert.ok(
      log.includes(
        path.join(root, ".verification", `verify-${result.runId}`, check.name.replaceAll(":", "-")),
      ),
    );
  }
  await assert.rejects(access(path.join(root, ".verification/verify.lock")), { code: "ENOENT" });
}

test("SIGINT during the final command never leaves passed evidence", async (t) => {
  await interruptionFixture(t);
});
test("SIGINT while releasing the checkout lock invalidates index and summary before its sole JSON result", async (t) => {
  await interruptionFixture(t, true);
});
