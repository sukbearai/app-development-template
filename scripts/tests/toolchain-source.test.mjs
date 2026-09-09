import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("Docker pnpm installation reads the manifest and rejects unpinned descriptors", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-toolchain-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const source = dockerfile.match(/RUN node <<'INSTALL_PNPM'\n([^]*?)\nINSTALL_PNPM/)[1];
  await mkdir(path.join(cwd, "bin"));
  const npm = path.join(cwd, "bin/npm");
  await writeFile(
    npm,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
  );
  await chmod(npm, 0o755);
  const run = () =>
    execFileSync(process.execPath, ["-e", source], {
      cwd,
      env: { ...process.env, PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
      stdio: "pipe",
    });
  for (const version of ["10.33.4", "11.2.3"]) {
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ packageManager: `pnpm@${version}` }),
    );
    assert.deepEqual(JSON.parse(run()), ["install", "--global", `pnpm@${version}`]);
  }
  for (const packageManager of [
    "pnpm@latest",
    "npm@11.2.3",
    "pnpm@10.33.4; touch injected",
    undefined,
  ]) {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager }));
    assert.throws(run, /packageManager must pin an exact pnpm version/);
  }
});

test("verification and release Actions use the checked-out packageManager", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  for (const workflow of ["ci.yml", "release.yml"]) {
    const source = await readFile(path.join(root, ".github/workflows", workflow), "utf8");
    const setup = source.match(
      /^(\s*)- uses: pnpm\/action-setup@[^\n]+\n([^]*?)(?=^\1- |$(?![^]))/m,
    );
    assert.ok(setup, `${workflow} must install pnpm`);
    assert.doesNotMatch(setup[2], /^\s+version:/m, `${workflow} overrides packageManager`);
    assert.ok(
      source.indexOf("actions/checkout@") < setup.index,
      "Read packageManager after checkout",
    );
  }
});
