import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { capacityLimitNames, compareCapacity } from "../capacity-comparison.mjs";
import { summarizeMetrics, summarizeRequests } from "../capacity-summary.mjs";

function fixture(index, candidate = false, rejected = 2) {
  const started = Date.UTC(2026, 8, 8, 0, index);
  const operations = Object.fromEntries(
    ["login", "read", "write", "upload"].map((operation) => {
      const observations = Array.from({ length: 10 }, (_, request) => ({
        operation,
        index: request,
        status: operation === "upload" && request < rejected ? 503 : 200,
        outcome: operation === "upload" && request < rejected ? "upload_busy" : "success",
        durationMs: operation === "upload" && request < rejected ? 1 : 100,
      }));
      return [operation, { ...summarizeRequests(observations, 1000), observations }];
    }),
  );
  const metricSamples = [1, 2].map((second) => ({
    observedAt: new Date(started + second * 1000).toISOString(),
    process: { rssBytes: 1000, heapUsedBytes: 500 },
    databasePool: { total: 2, waiting: 0 },
    uploads: { active: 2, rejectedTotal: second },
  }));
  return {
    version: 1,
    status: "passed",
    cleanupErrors: [],
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + 4000).toISOString(),
    comparison: {
      schemaVersion: 1,
      runId: `run-${index}`,
      source: {
        gitSha: (candidate ? "b" : "a").repeat(40),
        sourceSha256: (candidate ? "b" : "a").repeat(64),
        dirty: false,
      },
      environment: {
        machine: {
          hostname: "fixture",
          cpuModel: "fixture-cpu",
          cpuCount: 4,
          totalMemoryBytes: 8192,
        },
        platform: { os: "linux", release: "fixture", arch: "x64" },
        runtime: { node: "v22.20.0", pnpm: "10.33.4" },
        target: {
          mode: "production",
          replicas: 1,
          storage: "local",
          postgresImage: "postgres:17-alpine",
          uploadConcurrency: 2,
          databasePoolMax: 10,
        },
      },
      load: { start: [0, 0, 0], end: [0, 0, 0] },
    },
    options: { concurrency: 4, requests: 10, uploadBytes: 100 },
    data: { initialRoles: 1, initialFiles: 0 },
    operations,
    metrics: summarizeMetrics(metricSamples),
    metricSamples,
  };
}
function input() {
  return {
    baseline: [fixture(0), fixture(1), fixture(2)],
    candidate: [fixture(3, true), fixture(4, true), fixture(5, true)],
    rules: {
      schemaVersion: 1,
      reason: "Fixture has no noise; zero allowances catch injected regressions.",
      minimumRuns: 3,
      minimumSuccesses: 5,
      minimumOutcomeSamples: 2,
      maxLoadAverage: 1,
      maxLoadAverageDelta: 0.5,
      limits: Object.fromEntries(capacityLimitNames.map((name) => [name, 0])),
    },
  };
}
function compare(value) {
  return compareCapacity(value.baseline, value.candidate, value.rules);
}
function changeUpload(report, mutate) {
  const observations = report.operations.upload.observations;
  observations.forEach(mutate);
  report.operations.upload = { ...summarizeRequests(observations, 1000), observations };
}

test("compares repeated real capacity report fields and preserves source identities", () => {
  const result = compare(input());
  assert.equal(result.status, "passed");
  assert.equal(result.data.baseline.runIds.length, 3);
  assert.equal(
    result.data.comparisons.find((item) => item.metric === "upload.success.p95").baseline,
    100,
  );
  assert.notEqual(result.data.baseline.source.gitSha, result.data.candidate.source.gitSha);
});

test("known successful latency regression fails independently of fast rejection percentiles", () => {
  const value = input();
  value.candidate.forEach((report) =>
    changeUpload(report, (observation) => {
      if (observation.outcome === "success") observation.durationMs = 200;
    }),
  );
  const result = compare(value);
  assert.equal(result.errorCode, "CAPACITY_REGRESSION");
  assert.equal(
    result.data.comparisons.find((item) => item.metric === "upload.success.p95").passed,
    false,
  );
  assert.equal(
    result.data.comparisons.find((item) => item.metric === "upload.upload_busy.p95").passed,
    true,
  );
});

test("more fast rejections cannot count as successful throughput improvement", () => {
  const value = input();
  value.candidate = [3, 4, 5].map((index) => fixture(index, true, 4));
  const result = compare(value);
  assert.equal(result.status, "failed");
  for (const metric of ["upload.successfulPerSecond", "upload.rejectionRate"])
    assert.equal(result.data.comparisons.find((item) => item.metric === metric).passed, false);
});

const invalidReports = {
  "workload drift": (value) => {
    value.candidate[0].options.concurrency = 8;
  },
  "runtime drift": (value) => {
    value.candidate[0].comparison.environment.runtime.node = "v26.8.1";
  },
  "data drift": (value) => {
    value.candidate[0].data.initialRoles++;
  },
  "source drift": (value) => {
    value.candidate[0].comparison.source.sourceSha256 = "c".repeat(64);
  },
  "duplicate run": (value) => {
    value.candidate[0].comparison.runId = value.baseline[0].comparison.runId;
  },
  "sample shortage": (value) => {
    value.candidate.pop();
  },
  "missing metadata": (value) => {
    delete value.candidate[0].comparison;
  },
  "invalid timestamp": (value) => {
    value.candidate[0].startedAt = "2026-02-31T00:00:00.000Z";
  },
  "reversed timestamps": (value) => {
    value.candidate[0].finishedAt = value.candidate[0].startedAt;
  },
  "overlapping runs": (value) => {
    value.candidate[0].startedAt = value.baseline[0].startedAt;
  },
  "resource timestamp invalid": (value) => {
    value.candidate[0].metricSamples[0].observedAt = "yesterday";
  },
  "missing metrics": (value) => {
    delete value.candidate[0].metrics;
  },
  "NaN metric": (value) => {
    value.candidate[0].metrics.rssBytesPeak = NaN;
  },
  "negative metric": (value) => {
    value.candidate[0].metricSamples[0].process.rssBytes = -1;
  },
  "negative duration": (value) => {
    value.candidate[0].operations.upload.observations[0].durationMs = -1;
  },
  "NaN throughput": (value) => {
    value.candidate[0].operations.upload.successfulPerSecond = NaN;
  },
  "missing outcome percentiles": (value) => {
    delete value.candidate[0].operations.upload.latencyMsByOutcome.success;
  },
  "forged fast percentile": (value) => {
    value.candidate[0].operations.upload.latencyMsByOutcome.success.p95 = 1;
  },
  "missing raw requests": (value) => {
    delete value.candidate[0].operations.upload.observations;
  },
  "duplicate raw requests": (value) => {
    value.candidate[0].operations.upload.observations[0].index = 1;
  },
  "insufficient successful samples": (value) => {
    value.rules.minimumSuccesses = 9;
  },
  "outcome missing in some runs": (value) => {
    value.candidate = [3, 4, 5].map((index) => fixture(index, true, 0));
  },
  "machine load high": (value) => {
    value.candidate[0].comparison.load.end[0] = 2;
  },
  "machine load drift": (value) => {
    value.candidate[0].comparison.load.end[0] = 0.6;
  },
};
for (const [name, mutate] of Object.entries(invalidReports))
  test(`${name} is inconclusive`, () => {
    const value = input();
    mutate(value);
    assert.equal(compare(value).errorCode, "CAPACITY_NOT_COMPARABLE");
  });

test("explicit threshold file required; missing, negative and nonfinite limits are invalid", () => {
  for (const mutate of [
    (value) => {
      delete value.rules.limits.successLatencyMs;
    },
    (value) => {
      value.rules.limits.successLatencyMs = -1;
    },
    (value) => {
      value.rules.limits.successLatencyMs = Infinity;
    },
    (value) => {
      value.rules.minimumRuns = 1;
    },
  ]) {
    const value = input();
    mutate(value);
    assert.equal(compare(value).status, "invalid");
  }
});

test("failed run and cleanup failures cannot pass a permissive rule", () => {
  for (const mutate of [
    (report) => {
      report.status = "failed";
    },
    (report) => {
      report.cleanupErrors = ["owned_cleanup_failed"];
    },
    (report) => {
      delete report.cleanupErrors;
    },
  ]) {
    const value = input();
    mutate(value.candidate[0]);
    assert.equal(compare(value).errorCode, "CAPACITY_RUN_FAILED");
  }
});

test("CLI emits only JSON, retains hashed inputs and refuses unknown options", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "capacity-comparison-test-"));
  try {
    const value = input();
    const args = ["scripts/capacity-compare.mjs", "--json"];
    for (const group of ["baseline", "candidate"])
      for (const [index, report] of value[group].entries()) {
        const file = path.join(directory, `${group}-${index}.json`);
        await writeFile(file, JSON.stringify(report));
        args.push(`--${group}`, file);
      }
    const rulesFile = path.join(directory, "rules.json");
    await writeFile(rulesFile, JSON.stringify(value.rules));
    args.push("--rules", rulesFile);
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.command, "capacity-compare");
    assert.equal(envelope.status, "passed");
    assert.equal(envelope.evidence.length, 7);
    assert.ok(envelope.evidence.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.equal(JSON.parse(await readFile(rulesFile, "utf8")).reason, value.rules.reason);
    const changedReport = path.join(directory, "candidate-0.json");
    value.candidate[0].comparison.environment.runtime.node = "v99.0.0";
    await writeFile(changedReport, JSON.stringify(value.candidate[0]));
    const incompatible = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(incompatible.status, 3);
    assert.equal(JSON.parse(incompatible.stdout).errorCode, "CAPACITY_NOT_COMPARABLE");
    value.candidate[0] = fixture(3, true);
    value.candidate[0].status = "failed";
    await writeFile(changedReport, JSON.stringify(value.candidate[0]));
    const failure = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stdout).errorCode, "CAPACITY_RUN_FAILED");
    await writeFile(changedReport, "{");
    const malformed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).errorCode, "CAPACITY_INPUT_INVALID");
    const invalid = spawnSync(
      process.execPath,
      ["scripts/capacity-compare.mjs", "--json", "--bogus"],
      { encoding: "utf8" },
    );
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).status, "invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
