import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Manifest, VERSION, setLogger } from "release-please";
import { checkReleaseCandidateChannel, checkReleaseVersion } from "../release-version-check.mjs";

const config = JSON.parse(
  readFileSync(new URL("../../release-please-config.json", import.meta.url), "utf8"),
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const previousSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const noop = () => {};
setLogger({ info: noop, warn: noop, error: noop, debug: noop, trace: noop });

class ReleaseFixture {
  repository = { owner: "fixture", repo: "application", defaultBranch: "main" };
  releases = [];
  pullRequests = [];
  created = [];

  constructor(version, message, prerelease = false) {
    const fixtureConfig = structuredClone(config);
    fixtureConfig.packages["."].prerelease = prerelease;
    this.files = {
      "release-please-config.json": JSON.stringify(fixtureConfig),
      ".release-please-manifest.json": JSON.stringify({ ".": version }),
      "package.json": JSON.stringify({ name: "application", version, private: true }),
    };
    this.releases = [{ tagName: `v${version}`, sha: previousSha, notes: "Previous release" }];
    this.commits = [
      { sha: candidateSha, message, files: ["apps/web/app/page.tsx"] },
      { sha: previousSha, message: `chore(main): release ${version}`, files: ["package.json"] },
    ];
  }

  async getFileContentsOnBranch(path) {
    assert.ok(Object.hasOwn(this.files, path), `unexpected fixture read ${path}`);
    return {
      parsedContent: this.files[path],
      content: Buffer.from(this.files[path]).toString("base64"),
      sha: previousSha,
    };
  }

  async getFileJson(path) {
    return JSON.parse((await this.getFileContentsOnBranch(path)).parsedContent);
  }

  async *releaseIterator() {
    yield* this.releases;
  }
  async *mergeCommitIterator() {
    yield* this.commits;
  }
  async *tagIterator() {
    yield* [];
  }
  async *pullRequestIterator() {
    yield* this.pullRequests;
  }

  async createRelease(release, options) {
    const created = {
      id: this.created.length + 1,
      tagName: release.tag.toString(),
      sha: release.sha,
      draft: options.draft,
      url: "https://example.invalid/release",
    };
    this.created.push({ release, options });
    return created;
  }

  async commentOnIssue() {}

  async removeIssueLabels(labels, number) {
    const pullRequest = this.pullRequests.find((entry) => entry.number === number);
    pullRequest.labels = pullRequest.labels.filter((label) => !labels.includes(label));
  }

  async addIssueLabels(labels, number) {
    this.pullRequests.find((entry) => entry.number === number).labels.push(...labels);
  }

  manifest() {
    return Manifest.fromManifest(this, "main");
  }
}

test("fixtures use the same release-please version as the pinned action", () => {
  assert.equal(VERSION, "17.3.0");
  assert.equal(rootPackage.devDependencies["release-please"], VERSION);
});

for (const [current, message, expected, prerelease = false] of [
  ["0.1.0", "fix: 修复登录", "0.1.1"],
  ["0.1.0", "feat: 增加导出", "0.1.1"],
  ["0.1.0", "feat!: 调整接口", "0.2.0"],
  ["0.1.0", "fix: 调整接口\n\nBREAKING CHANGE: 删除旧字段", "0.2.0"],
  ["1.2.3", "fix: 修复登录", "1.2.4"],
  ["1.2.3", "feat: 增加导出", "1.3.0"],
  ["1.2.3", "feat!: 调整接口", "2.0.0"],
  ["1.2.3", "docs: 更新说明", undefined],
  ["0.1.0", "chore: 更新工具", undefined],
  ["0.1.0", "feat: 增加导出", "0.1.1-rc.1", true],
  ["0.1.0", "feat!: 调整接口", "0.2.0-rc.1", true],
  ["1.2.3", "feat: 增加导出", "1.3.0-rc.1", true],
  ["1.3.0-rc.1", "fix: 修复候选版本", "1.3.0-rc.2", true],
  ["1.2.4-rc.1", "feat: 增加接口", "1.3.0-rc.1", true],
  ["1.2.4-rc.1", "feat!: 重构接口", "2.0.0-rc.1", true],
  ["1.3.0-rc.2", "fix: 完成正式发行验证", "1.3.0"],
]) {
  test(`${current} ${message.split("\n")[0]} -> ${expected ?? "no release"}`, async () => {
    const fixture = new ReleaseFixture(current, message, prerelease);
    const manifest = await fixture.manifest();
    const candidates = await manifest.buildPullRequests();
    if (expected === undefined) {
      assert.deepEqual(candidates, []);
      return;
    }
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    const rendered = Object.fromEntries(
      candidate.updates
        .filter((update) => update.createIfMissing || Object.hasOwn(fixture.files, update.path))
        .map((update) => [update.path, update.updater.updateContent(fixture.files[update.path])]),
    );
    assert.equal(JSON.parse(rendered["package.json"]).version, expected);
    assert.equal(JSON.parse(rendered[".release-please-manifest.json"])["."], expected);
    checkReleaseCandidateChannel(JSON.parse(fixture.files["release-please-config.json"]), expected);
    assert.ok(candidate.title.toString().includes(expected));
    checkReleaseVersion(
      JSON.parse(fixture.files["release-please-config.json"]),
      JSON.parse(rendered[".release-please-manifest.json"]),
      JSON.parse(rendered["package.json"]),
      rendered["CHANGELOG.md"],
    );
    assert.ok(rendered["CHANGELOG.md"].includes(message.split("\n")[0].split(": ")[1]));
  });
}

test("bootstrap excludes old history without forcing the first release number", async () => {
  const fixture = new ReleaseFixture("0.1.0", "feat: 增加导出");
  fixture.releases = [];
  fixture.commits[1].sha = config["bootstrap-sha"];
  fixture.commits.push({
    sha: "c".repeat(40),
    message: "feat!: 历史变更",
    files: ["package.json"],
  });
  const [candidate] = await (await fixture.manifest()).buildPullRequests();
  const packageUpdate = candidate.updates.find((update) => update.path === "package.json");
  assert.equal(
    JSON.parse(packageUpdate.updater.updateContent(fixture.files["package.json"])).version,
    "0.1.1",
  );
});

test("candidate validation rejects channel drift while ordinary validation permits a channel transition", () => {
  const changed = structuredClone(config);
  changed.packages["."].prerelease = true;
  checkReleaseVersion(changed, { ".": "0.1.0" }, { version: "0.1.0" });
  assert.throws(() => checkReleaseCandidateChannel(changed, "0.1.0"), /configured release channel/);
  assert.throws(
    () => checkReleaseCandidateChannel(config, "0.1.1-rc.1"),
    /configured release channel/,
  );
});

for (const prerelease of [false, true])
  test(`draft creation preserves merge SHA and retry identity, prerelease=${prerelease}`, async () => {
    const fixture = new ReleaseFixture("0.1.0", "feat: 增加导出", prerelease);
    const [candidate] = await (await fixture.manifest()).buildPullRequests();
    fixture.pullRequests = [
      {
        number: 42,
        title: candidate.title.toString(),
        body: candidate.body.toString(),
        headBranchName: candidate.headRefName,
        baseBranchName: "main",
        sha: candidateSha,
        labels: ["autorelease: pending"],
        files: ["package.json", "CHANGELOG.md", ".release-please-manifest.json"],
      },
    ];
    const [created] = await (await fixture.manifest()).createReleases();
    assert.equal(created.id, 1);
    assert.equal(created.sha, candidateSha);
    assert.equal(created.tagName, prerelease ? "v0.1.1-rc.1" : "v0.1.1");
    assert.equal(created.draft, true);
    assert.equal(created.prNumber, 42);
    assert.deepEqual(fixture.created[0].options, { draft: true, prerelease, forceTag: true });
    assert.deepEqual(await (await fixture.manifest()).createReleases(), []);
    assert.equal(fixture.created.length, 1);
  });

test("version validation rejects drift, unsafe policy and missing release notes", () => {
  const pkg = { version: "0.1.0" };
  assert.equal(checkReleaseVersion(config, { ".": pkg.version }, pkg).version, pkg.version);
  assert.throws(
    () => checkReleaseVersion(config, { ".": "0.2.0" }, pkg),
    /manifest and application/,
  );
  assert.throws(
    () => checkReleaseVersion(config, { ".": "0.2.0" }, { version: "0.2.0" }),
    /omit CHANGELOG/,
  );
  assert.throws(
    () => checkReleaseVersion(config, { ".": pkg.version }, pkg, "## [0.2.0]"),
    /latest CHANGELOG/,
  );
  for (const key of [
    "draft",
    "bump-minor-pre-major",
    "bump-patch-for-minor-pre-major",
    "include-v-in-tag",
    "force-tag-creation",
  ]) {
    const changed = structuredClone(config);
    changed.packages["."][key] = false;
    assert.throws(() => checkReleaseVersion(changed, { ".": pkg.version }, pkg), /release policy/);
  }
  const extraPackage = structuredClone(config);
  extraPackage.packages["apps/web"] = {};
  assert.throws(() => checkReleaseVersion(extraPackage, { ".": pkg.version }, pkg));
});
