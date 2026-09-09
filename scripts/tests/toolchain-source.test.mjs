import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("Docker installer verifies locked download bytes before invoking npm", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pstack-toolchain-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const installer = dockerfile.match(/RUN node <<'INSTALL_PNPM'\n([^]*?)\nINSTALL_PNPM/)[1];
  const downloadedFile = path.join(cwd, "downloaded-pnpm.tgz");
  const source = installer.replaceAll('"/tmp/pnpm.tgz"', JSON.stringify(downloadedFile));
  assert.notEqual(source, installer, "Fixture must isolate the installer's temporary archive");
  await mkdir(path.join(cwd, "bin"));
  await mkdir(path.join(cwd, "package"));
  await writeFile(
    path.join(cwd, "package/package.json"),
    JSON.stringify({ name: "pnpm", version: "10.33.4" }),
  );
  execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd });
  const archive = await readFile(path.join(cwd, "package.tgz"));
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const npm = path.join(cwd, "bin/npm");
  await writeFile(
    npm,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const content = fs.readFileSync(args[2]);
fs.writeFileSync("npm-call.json", JSON.stringify({ args, content: content.toString("base64") }));
`,
  );
  await chmod(npm, 0o755);
  const bootstrap = `
globalThis.fetch = async (url) => {
  const fs = require("node:fs");
  fs.writeFileSync("fetch-call.json", JSON.stringify({ url }));
  return new Response(fs.readFileSync("response.tgz"), { status: Number(process.env.FIXTURE_HTTP_STATUS) });
};
`;
  const run = (status = 200) =>
    execFileSync(process.execPath, ["-e", bootstrap + source], {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH}`,
        FIXTURE_HTTP_STATUS: String(status),
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  const configure = async (packageManager, version = "10.33.4", bytes = archive) => {
    await rm(path.join(cwd, "npm-call.json"), { force: true });
    await rm(path.join(cwd, "fetch-call.json"), { force: true });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager }));
    await writeFile(
      path.join(cwd, "toolchain-lock.json"),
      JSON.stringify({ pnpm: { version, integrity } }),
    );
    await writeFile(path.join(cwd, "response.tgz"), bytes);
  };
  await configure("pnpm@10.33.4");
  run();
  const call = JSON.parse(await readFile(path.join(cwd, "npm-call.json"), "utf8"));
  assert.deepEqual(call.args, ["install", "--global", downloadedFile]);
  assert.deepEqual(Buffer.from(call.content, "base64"), archive);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, "fetch-call.json"), "utf8")), {
    url: "https://registry.npmjs.org/pnpm/-/pnpm-10.33.4.tgz",
  });
  await assert.rejects(readFile(downloadedFile), { code: "ENOENT" });

  for (const packageManager of [
    "pnpm@latest",
    "npm@11.2.3",
    "pnpm@10.33.4; touch injected",
    undefined,
  ]) {
    await configure(packageManager);
    assert.throws(run, /packageManager must pin an exact pnpm version/);
    await assert.rejects(readFile(path.join(cwd, "fetch-call.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(cwd, "npm-call.json")), { code: "ENOENT" });
  }
  await configure("pnpm@11.2.3");
  assert.throws(run, /pnpm toolchain mismatch/);
  await assert.rejects(readFile(path.join(cwd, "fetch-call.json")), { code: "ENOENT" });
  await configure("pnpm@10.33.4", "10.33.4", Buffer.from("tampered archive"));
  assert.throws(run, /pnpm integrity mismatch/);
  await assert.rejects(readFile(path.join(cwd, "npm-call.json")), { code: "ENOENT" });
  await assert.rejects(readFile(downloadedFile), { code: "ENOENT" });
  await configure("pnpm@10.33.4");
  assert.throws(() => run(503), /pnpm download failed/);
  await assert.rejects(readFile(path.join(cwd, "npm-call.json")), { code: "ENOENT" });
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
