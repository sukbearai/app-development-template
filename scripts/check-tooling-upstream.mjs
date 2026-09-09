import assert from "node:assert/strict";
import { z } from "zod";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const shaPattern = /^[a-f0-9]{40}$/;

const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
  );
const paths = z
  .array(relativePath)
  .min(1)
  .refine((value) => new Set(value).size === value.length);
const metadataSchema = z
  .object({
    version: z.literal(1),
    tools: z
      .array(
        z
          .object({
            id: z.enum(["anti-slop", "hallmark"]),
            repository: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
            localRoot: relativePath,
            upstreamRoot: z.union([z.literal(""), relativePath]),
            mode: z.enum(["verbatim", "adapted"]),
            trackedRef: z.literal("default-branch"),
            validationCommands: z.array(z.string().trim().min(1)).min(1),
            sources: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
                    revision: z.string().regex(shaPattern),
                    upstreamPaths: paths,
                    localPaths: paths,
                    attributionFile: relativePath,
                    adaptation: z.string().trim().min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();

export async function validateUpstreamSources(cwd = root) {
  const metadata = metadataSchema.parse(
    JSON.parse(await readFile(path.join(cwd, "tools/upstream-sources.json"), "utf8")),
  );
  assert.ok(
    metadata.tools.length === 2 && new Set(metadata.tools.map((tool) => tool?.id)).size === 2,
    "Expected exactly anti-slop and hallmark",
  );
  for (const tool of metadata.tools) {
    const ids = new Set();
    const localPaths = new Set();
    for (const source of tool.sources) {
      const label = `${tool.id}/${source?.id}`;
      assert.ok(!ids.has(source.id), `${label}: invalid/duplicate source id`);
      ids.add(source.id);
      for (const filename of source.localPaths) {
        assert.ok(!localPaths.has(filename), `${label}: duplicate local path ${filename}`);
        localPaths.add(filename);
        await stat(path.join(cwd, tool.localRoot, filename));
      }
      const attribution = await readFile(
        path.join(cwd, tool.localRoot, source.attributionFile),
        "utf8",
      );
      const revisions = attribution.match(/\b[a-f0-9]{40}\b/g) ?? [];
      assert.ok(
        revisions.length > 0 && revisions.every((revision) => revision === source.revision),
        `${label}: attribution revision drift in ${source.attributionFile}`,
      );
      assert.ok(
        attribution.includes(
          tool.id === "hallmark" ? "Hallmark" : `https://github.com/${tool.repository}`,
        ),
        `${label}: attribution source missing`,
      );
      for (const match of attribution.matchAll(
        /https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([a-f0-9]{40})\/([^\s)]+)/g,
      )) {
        assert.ok(
          match[1] === tool.repository &&
            match[2] === source.revision &&
            source.upstreamPaths.some(
              (filename) => path.posix.join(tool.upstreamRoot, filename) === match[3],
            ),
          `${label}: attribution upstream path drift`,
        );
      }
    }
    if (tool.id === "hallmark") {
      const references = await readdir(path.join(cwd, tool.localRoot, "references"));
      assert.ok(
        references
          .filter((name) => name.endsWith(".md"))
          .every((name) => localPaths.has(`references/${name}`)),
        "hallmark: untracked local reference",
      );
      assert.ok(
        localPaths.has("SKILL.md") && localPaths.has("LICENSE"),
        "hallmark: missing skill/license source",
      );
    } else {
      assert.ok(
        localPaths.has("src") && localPaths.has("LICENSE"),
        "anti-slop: missing source/license",
      );
    }
  }
  return metadata;
}

async function githubJson(endpoint, fetchImpl, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
  } catch {
    throw new Error("GitHub request failed or timed out");
  }
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

function compareStatus(comparison, revision, head) {
  assert.ok(
    comparison?.base_commit?.sha === revision,
    "GitHub comparison is missing the pinned base",
  );
  assert.ok(
    (comparison.status === "identical") === (revision === head),
    "GitHub comparison does not match the resolved head",
  );
  const ahead = comparison.ahead_by;
  const behind = comparison.behind_by;
  assert.ok(
    Number.isSafeInteger(ahead) && ahead >= 0 && Number.isSafeInteger(behind) && behind >= 0,
    "Invalid GitHub comparison counts",
  );
  const states = {
    identical: [ahead === 0 && behind === 0, "current"],
    ahead: [ahead > 0 && behind === 0, "update-available"],
    behind: [ahead === 0 && behind > 0, "ahead"],
    diverged: [ahead > 0 && behind > 0, "diverged"],
  };
  const state = states[comparison.status];
  assert.ok(Array.isArray(state) && state[0], "Invalid GitHub comparison status");
  return state[1];
}

export async function checkToolingUpstream({
  cwd = root,
  remote = false,
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
} = {}) {
  const metadata = await validateUpstreamSources(cwd);
  const results = [];
  for (const tool of metadata.tools) {
    let head;
    let branch;
    let unavailable;
    const comparisons = new Map();
    if (remote) {
      try {
        const repository = await githubJson(`/repos/${tool.repository}`, fetchImpl, token);
        branch = z.string().min(1).parse(repository.default_branch);
        const commit = await githubJson(
          `/repos/${tool.repository}/commits/${encodeURIComponent(branch)}`,
          fetchImpl,
          token,
        );
        head = z.string().regex(shaPattern).parse(commit.sha);
      } catch (error) {
        unavailable =
          error instanceof z.ZodError
            ? "Invalid GitHub repository or branch response"
            : error.message;
      }
    }
    for (const source of tool.sources) {
      const result = {
        tool: tool.id,
        source: source.id,
        repository: tool.repository,
        mode: tool.mode,
        revision: source.revision,
        upstreamPaths: source.upstreamPaths.map((filename) =>
          path.posix.join(tool.upstreamRoot, filename),
        ),
        localPaths: source.localPaths.map((filename) => path.posix.join(tool.localRoot, filename)),
        adaptation: source.adaptation,
        validationCommands: tool.validationCommands,
        status: remote ? "unavailable" : "validated",
      };
      if (remote && !unavailable) {
        if (!comparisons.has(source.revision)) {
          try {
            const comparison = await githubJson(
              `/repos/${tool.repository}/compare/${source.revision}...${head}`,
              fetchImpl,
              token,
            );
            comparisons.set(source.revision, {
              status: compareStatus(comparison, source.revision, head),
              upstreamAheadBy: comparison.ahead_by,
              upstreamBehindBy: comparison.behind_by,
            });
          } catch (error) {
            comparisons.set(source.revision, { status: "unavailable", error: error.message });
          }
        }
        Object.assign(result, comparisons.get(source.revision), {
          branch,
          head,
          scope: "repository",
          compareUrl: `https://github.com/${tool.repository}/compare/${source.revision}...${head}`,
        });
      } else if (unavailable) result.error = unavailable;
      results.push(result);
    }
  }
  return {
    mode: remote ? "remote" : "offline",
    ok: results.every((result) => result.status !== "unavailable"),
    results,
  };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.every((arg) => ["--remote", "--json"].includes(arg)),
    "Usage: node scripts/check-tooling-upstream.mjs [--remote] [--json]",
  );
  const report = await checkToolingUpstream({ remote: args.includes("--remote") });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      report.mode === "offline"
        ? "Local source metadata validated; upstream was not queried."
        : "Repository-level comparison only; source-path changes have not been determined.",
    );
    for (const result of report.results) {
      console.log(
        `${result.tool}/${result.source}: ${result.status} (${result.mode}, pinned ${result.revision})`,
      );
      if (result.head) console.log(`  ${result.branch}: ${result.head}\n  ${result.compareUrl}`);
      if (result.error) console.log(`  ${result.error}`);
      console.log(
        `  Upstream: ${result.upstreamPaths.join(", ")}\n  Local: ${result.localPaths.join(", ")}`,
      );
      console.log(`  Validation: ${result.validationCommands.join("; ")}`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (process.argv.includes("--json"))
      console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`Upstream check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
