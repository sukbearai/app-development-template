import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const operations = ["login", "read", "write", "upload"];
const outcomes = { success: "successful", upload_busy: "uploadBusy", failed: "failed" };
const resources = [
  "rssBytesPeak",
  "heapUsedBytesPeak",
  "poolTotalPeak",
  "poolWaitingPeak",
  "uploadsActivePeak",
  "uploadRejectedDelta",
];
export const capacityLimitNames = [
  "successLatencyMs",
  "rejectionLatencyMs",
  "failureLatencyMs",
  "successfulPerSecond",
  "failureRate",
  "rejectionRate",
  ...resources,
];

function nonnegative(value, label) {
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
  return value;
}
function count(value, label, minimum = 0) {
  nonnegative(value, label);
  assert.ok(
    Number.isSafeInteger(value) && value >= minimum,
    `${label} must be an integer >= ${minimum}`,
  );
}
function timestamp(value) {
  assert.ok(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      new Date(value).toISOString() === value,
    "Invalid timestamp",
  );
  return Date.parse(value);
}
function text(value) {
  assert.ok(String(value) === value && value.trim().length > 0, "Missing identity text");
}
function percentile(values, fraction) {
  return values.length
    ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
    : null;
}
function same(left, right, label) {
  assert.ok(isDeepStrictEqual(left, right), label);
}

export function validateCapacityRules(rules) {
  assert.equal(rules.schemaVersion, 1, "Unsupported rules schema");
  text(rules.reason);
  count(rules.minimumRuns, "minimumRuns", 2);
  count(rules.minimumSuccesses, "minimumSuccesses", 1);
  count(rules.minimumOutcomeSamples, "minimumOutcomeSamples", 1);
  nonnegative(rules.maxLoadAverage, "maxLoadAverage");
  nonnegative(rules.maxLoadAverageDelta, "maxLoadAverageDelta");
  same(
    Object.keys(rules.limits).sort(),
    [...capacityLimitNames].sort(),
    "Every metric needs an explicit limit",
  );
  for (const name of capacityLimitNames) nonnegative(rules.limits[name], `limits.${name}`);
  return rules;
}

function checkMetadata(report) {
  assert.equal(report.version, 1, "Unsupported capacity report");
  const metadata = report.comparison;
  assert.equal(metadata.schemaVersion, 1, "Missing comparison metadata");
  text(metadata.runId);
  assert.match(metadata.source.gitSha, /^[a-f0-9]{40}$/);
  assert.match(metadata.source.sourceSha256, /^[a-f0-9]{64}$/);
  assert.ok([true, false].includes(metadata.source.dirty), "Missing dirty state");
  const { machine, platform, runtime, target } = metadata.environment;
  for (const value of [
    machine.hostname,
    machine.cpuModel,
    platform.os,
    platform.release,
    platform.arch,
    runtime.node,
    runtime.pnpm,
  ])
    text(value);
  count(machine.cpuCount, "cpuCount", 1);
  count(machine.totalMemoryBytes, "totalMemoryBytes", 1);
  assert.equal(target.mode, "production");
  assert.equal(target.replicas, 1);
  assert.equal(target.storage, "local");
  text(target.postgresImage);
  count(target.uploadConcurrency, "uploadConcurrency", 1);
  count(target.databasePoolMax, "databasePoolMax", 1);
  for (const values of [metadata.load.start, metadata.load.end]) {
    assert.equal(values.length, 3, "Three load averages required");
    values.forEach((value) => nonnegative(value, "load average"));
  }
  const started = timestamp(report.startedAt);
  const finished = timestamp(report.finishedAt);
  assert.ok(finished > started, "Invalid report interval");
  count(report.options.concurrency, "concurrency", 1);
  count(report.options.requests, "requests", 1);
  count(report.options.uploadBytes, "uploadBytes", 1);
  count(report.data.initialRoles, "initialRoles");
  count(report.data.initialFiles, "initialFiles");
  return { started, finished };
}

function checkOperation(operation, report, rules, metrics) {
  const value = report.operations[operation];
  count(value.issued, "issued", 1);
  assert.equal(value.issued, report.options.requests, "Incomplete operation");
  assert.ok(value.elapsedMs > 0, "Missing operation duration");
  nonnegative(value.elapsedMs, "elapsedMs");
  const observations = value.observations;
  assert.equal(observations.length, value.issued, "Missing raw request samples");
  const indexes = new Set();
  for (const observation of observations) {
    count(observation.index, "request index");
    assert.ok(
      observation.index < value.issued && !indexes.has(observation.index),
      "Duplicate or invalid request index",
    );
    indexes.add(observation.index);
    assert.ok(Object.hasOwn(outcomes, observation.outcome), "Unknown request outcome");
    nonnegative(observation.durationMs, "request duration");
    assert.ok(observation.durationMs <= value.elapsedMs, "Request exceeds phase duration");
  }
  for (const [outcome, key] of Object.entries(outcomes)) {
    count(value[key], key);
    const durations = observations
      .filter((item) => item.outcome === outcome)
      .map((item) => item.durationMs);
    assert.equal(value[key], durations.length, "Outcome count does not match raw samples");
    const percentiles = value.latencyMsByOutcome[outcome];
    for (const [name, fraction] of [
      ["p50", 0.5],
      ["p95", 0.95],
      ["p99", 0.99],
    ]) {
      assert.equal(
        percentiles[name],
        percentile(durations, fraction),
        "Outcome percentile does not match raw samples",
      );
      if (durations.length)
        metrics[`${operation}.${outcome}.${name}`] = {
          value: percentiles[name],
          limit:
            outcome === "success"
              ? "successLatencyMs"
              : outcome === "upload_busy"
                ? "rejectionLatencyMs"
                : "failureLatencyMs",
        };
    }
    assert.ok(
      outcome !== "upload_busy" || operation === "upload" || durations.length === 0,
      "Rejection on non-upload operation",
    );
    if (durations.length)
      assert.ok(
        durations.length >=
          (outcome === "success" ? rules.minimumSuccesses : rules.minimumOutcomeSamples),
        "Insufficient outcome samples",
      );
  }
  assert.ok(value.successful >= rules.minimumSuccesses, "Insufficient successful samples");
  for (const [name, expected] of [
    ["requestsPerSecond", (value.issued * 1000) / value.elapsedMs],
    ["successfulPerSecond", (value.successful * 1000) / value.elapsedMs],
  ]) {
    nonnegative(value[name], name);
    assert.ok(
      Math.abs(value[name] - expected) <= Math.max(1, expected) * 1e-10,
      "Throughput does not match raw counts",
    );
  }
  metrics[`${operation}.successfulPerSecond`] = {
    value: value.successfulPerSecond,
    limit: "successfulPerSecond",
    decrease: true,
  };
  metrics[`${operation}.failureRate`] = {
    value: value.failed / value.issued,
    limit: "failureRate",
  };
  metrics[`${operation}.rejectionRate`] = {
    value: value.uploadBusy / value.issued,
    limit: "rejectionRate",
  };
}

function checkResources(report, metrics, interval) {
  const samples = report.metricSamples;
  assert.ok(Array.isArray(samples) && samples.length >= 2, "Missing raw resource samples");
  assert.equal(report.metrics.samples, samples.length, "Resource sample count mismatch");
  assert.equal(
    report.metrics.firstObservedAt,
    samples[0].observedAt,
    "First resource timestamp mismatch",
  );
  assert.equal(
    report.metrics.lastObservedAt,
    samples.at(-1).observedAt,
    "Last resource timestamp mismatch",
  );
  let previous = interval.started;
  const readings = {
    rssBytesPeak: (sample) => sample.process.rssBytes,
    heapUsedBytesPeak: (sample) => sample.process.heapUsedBytes,
    poolTotalPeak: (sample) => sample.databasePool.total,
    poolWaitingPeak: (sample) => sample.databasePool.waiting,
    uploadsActivePeak: (sample) => sample.uploads.active,
  };
  for (const sample of samples) {
    const observed = timestamp(sample.observedAt);
    assert.ok(
      observed >= previous && observed <= interval.finished,
      "Resource timestamp outside report or unordered",
    );
    previous = observed;
    for (const read of Object.values(readings)) nonnegative(read(sample), "resource sample");
    count(sample.uploads.rejectedTotal, "rejectedTotal");
  }
  for (const [name, read] of Object.entries(readings))
    assert.equal(report.metrics[name], Math.max(...samples.map(read)), "Resource peak mismatch");
  assert.equal(
    report.metrics.uploadRejectedDelta,
    samples.at(-1).uploads.rejectedTotal - samples[0].uploads.rejectedTotal,
    "Rejection counter mismatch",
  );
  for (let index = 1; index < samples.length; index++)
    assert.ok(
      samples[index].uploads.rejectedTotal >= samples[index - 1].uploads.rejectedTotal,
      "Rejection counter reset",
    );
  for (const name of resources)
    metrics[name] = { value: nonnegative(report.metrics[name], name), limit: name };
}

function checkReports(baseline, candidate, rules) {
  assert.ok(
    baseline.length >= rules.minimumRuns && candidate.length >= rules.minimumRuns,
    "Insufficient repeated runs",
  );
  const reference = baseline[0];
  const ids = new Set();
  const intervals = [];
  const loads = [];
  const groups = [];
  for (const reports of [baseline, candidate]) {
    const group = [];
    for (const report of reports) {
      const interval = checkMetadata(report);
      intervals.push(interval);
      assert.ok(!ids.has(report.comparison.runId), "Duplicate run identity");
      ids.add(report.comparison.runId);
      same(
        report.comparison.source,
        reports[0].comparison.source,
        "Source drift within repeated runs",
      );
      same(report.comparison.environment, reference.comparison.environment, "Environment mismatch");
      same(report.options, reference.options, "Workload configuration mismatch");
      same(report.data, reference.data, "Initial data mismatch");
      loads.push(...report.comparison.load.start, ...report.comparison.load.end);
      const metrics = {};
      for (const operation of operations) checkOperation(operation, report, rules, metrics);
      checkResources(report, metrics, interval);
      group.push(metrics);
    }
    groups.push(group);
  }
  intervals.sort((a, b) => a.started - b.started);
  for (let index = 1; index < intervals.length; index++)
    assert.ok(
      intervals[index].started >= intervals[index - 1].finished,
      "Measurement runs overlap",
    );
  assert.ok(Math.max(...loads) <= rules.maxLoadAverage, "Machine load exceeds declared maximum");
  for (let index = 0; index < 3; index++) {
    const values = [...baseline, ...candidate].flatMap((report) => [
      report.comparison.load.start[index],
      report.comparison.load.end[index],
    ]);
    assert.ok(
      Math.max(...values) - Math.min(...values) <= rules.maxLoadAverageDelta,
      "Machine load drift exceeds declared limit",
    );
  }
  const metricNames = Object.keys(groups[0][0]).sort();
  for (const group of groups)
    for (const sample of group)
      same(
        Object.keys(sample).sort(),
        metricNames,
        "Outcome absent from some repeated runs; latency comparison unavailable",
      );
  return groups;
}

export function compareCapacity(baseline, candidate, rules) {
  try {
    validateCapacityRules(rules);
  } catch (error) {
    return {
      status: "invalid",
      errorCode: "CAPACITY_RULES_INVALID",
      data: { reason: error.message },
    };
  }
  let groups;
  try {
    groups = checkReports(baseline, candidate, rules);
  } catch (error) {
    return {
      status: "inconclusive",
      errorCode: "CAPACITY_NOT_COMPARABLE",
      data: { reason: error.message },
    };
  }
  const comparisons = Object.entries(groups[0][0]).map(([metric, definition]) => {
    const [before, after] = groups.map((group) =>
      percentile(
        group.map((sample) => sample[metric].value),
        0.5,
      ),
    );
    const regression = definition.decrease ? before - after : after - before;
    return {
      metric,
      baseline: before,
      candidate: after,
      regression,
      allowedRegression: rules.limits[definition.limit],
      passed: regression <= rules.limits[definition.limit],
    };
  });
  const runs = [...baseline, ...candidate];
  const failedRun = runs.some(
    (report) =>
      report.status !== "passed" ||
      !Array.isArray(report.cleanupErrors) ||
      report.cleanupErrors.length ||
      operations.some((operation) => report.operations[operation].failed > 0),
  );
  const passed = !failedRun && comparisons.every((item) => item.passed);
  return {
    status: passed ? "passed" : "failed",
    errorCode: passed ? null : failedRun ? "CAPACITY_RUN_FAILED" : "CAPACITY_REGRESSION",
    data: {
      aggregation: "median of per-run metrics (nearest rank)",
      baseline: {
        source: baseline[0].comparison.source,
        runIds: baseline.map((report) => report.comparison.runId),
      },
      candidate: {
        source: candidate[0].comparison.source,
        runIds: candidate.map((report) => report.comparison.runId),
      },
      rules,
      comparisons,
    },
  };
}
