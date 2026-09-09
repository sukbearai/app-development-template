import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkReleaseVersion(config, manifest, packageJson, changelog) {
  assert.deepEqual(Object.keys(config).sort(), ["$schema", "bootstrap-sha", "packages"]);
  assert.equal(
    config.$schema,
    "https://raw.githubusercontent.com/googleapis/release-please/891bcf6253b390e39df9ff3e1c059a836bd39c98/schemas/config.json",
  );
  assert.match(config["bootstrap-sha"], /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(config.packages), ["."]);
  const policy = config.packages["."];
  assert.ok(
    [true, false].includes(policy.prerelease),
    "prerelease must explicitly select a channel",
  );
  assert.deepEqual(
    policy,
    {
      "release-type": "node",
      versioning: "prerelease",
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": true,
      "prerelease-type": "rc.1",
      prerelease: policy.prerelease,
      "include-component-in-tag": false,
      "include-v-in-tag": true,
      draft: true,
      "force-tag-creation": true,
      "changelog-path": "CHANGELOG.md",
    },
    "release policy must preserve the reviewed application version and draft rules",
  );
  assert.match(packageJson.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/);
  assert.deepEqual(
    manifest,
    { ".": packageJson.version },
    "manifest and application version must match",
  );
  if (changelog === undefined) {
    assert.equal(
      packageJson.version,
      "0.1.0",
      "only the unreleased bootstrap version may omit CHANGELOG.md",
    );
  } else {
    const heading = changelog.match(/^#{1,2} \[?(\d+\.\d+\.\d+(?:-rc\.\d+)?)(?:\]|\s|$)/m);
    assert.equal(
      heading?.[1],
      packageJson.version,
      "latest CHANGELOG version must match the application",
    );
  }
  return { version: packageJson.version, channel: policy.prerelease ? "rc" : "stable" };
}

export function checkReleaseCandidateChannel(config, version) {
  assert.equal(
    config.packages["."].prerelease,
    version.includes("-rc."),
    "candidate version must match the configured release channel",
  );
}

export async function readReleaseVersion(root, candidate = false) {
  const readJson = async (name) => JSON.parse(await readFile(resolve(root, name), "utf8"));
  const [config, manifest, packageJson, changelog] = await Promise.all([
    readJson("release-please-config.json"),
    readJson(".release-please-manifest.json"),
    readJson("package.json"),
    readFile(resolve(root, "CHANGELOG.md"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  const result = checkReleaseVersion(config, manifest, packageJson, changelog);
  if (candidate) checkReleaseCandidateChannel(config, result.version);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      args.length === 0 || (args.length === 1 && args[0] === "--candidate"),
      "only --candidate is accepted",
    );
    const result = await readReleaseVersion(process.cwd(), args.includes("--candidate"));
    console.log(`Release version ${result.version} is consistent; channel ${result.channel}.`);
  } catch (error) {
    console.error(`Release version check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
