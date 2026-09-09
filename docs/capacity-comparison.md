# Compare repeated capacity measurements

`node scripts/capacity-compare.mjs` compares retained `capacity.json` reports from [the local capacity workload](capacity.md). It reads reports and an explicit rules file. It does not run a workload, replace a baseline, or assign a production SLA.

Run each baseline and candidate measurement serially on the same machine, using isolated checkouts without active dotenv files. Keep the source and configuration unchanged within each group. Retain every run directory, including the raw request and resource samples. Run at least the number of repetitions declared in the rules. The tool requires at least two repetitions per group; that minimum alone does not establish a stable benchmark. Choose sample counts and thresholds from observed variation and the application's reviewed targets.

```sh
node scripts/capacity-compare.mjs --json \
  --baseline artifacts/baseline/run-1/capacity.json \
  --baseline artifacts/baseline/run-2/capacity.json \
  --candidate artifacts/candidate/run-1/capacity.json \
  --candidate artifacts/candidate/run-2/capacity.json \
  --rules artifacts/capacity-rules.json > artifacts/capacity-comparison.json
```

Repeat `--baseline` and `--candidate` for additional runs. The command rejects unknown arguments. Its JSON stdout contains one E4 envelope with `schemaVersion`, `command`, `runId`, `status`, `errorCode`, `evidence`, and `data`. Every input reference includes its SHA-256 and path relative to the invoking directory. Archive these input files alongside the output; the comparator does not copy them. Human-mode diagnostics go to stderr.

Exit codes are `0` for passed, `1` for failed, `2` for invalid arguments, JSON or rules, `3` for inconclusive measurements, and `130` for interruption. A missing report, incompatible measurements, or absent outcome samples never produce a passed result.

## Required measurement facts

The workload records `startedAt`, `finishedAt`, initial role and file counts in `data`, original workload `options`, per-operation `observations`, and `metricSamples`. The verifier adds `comparison` with the following fields:

| Field                    | Contents                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `runId` | Version `1` and a unique run identity                                                                                                        |
| `source`                 | Full `gitSha`, boolean `dirty`, and `sourceSha256`                                                                                           |
| `environment.machine`    | `hostname`, `cpuModel`, `cpuCount`, `totalMemoryBytes`                                                                                       |
| `environment.platform`   | `os`, `release`, `arch`                                                                                                                      |
| `environment.runtime`    | Actual `node` and `pnpm` versions                                                                                                            |
| `environment.target`     | `mode: "production"`, `replicas: 1`, `storage: "local"`, `postgresImage`, `uploadConcurrency`, `databasePoolMax`, and other fixture settings |
| `load`                   | Three host load averages in `start` and `end` arrays                                                                                         |

The comparator requires the complete environment, workload options and initial data counts to match exactly across both groups. Source identity must match within each group. Run IDs must be unique and workload time intervals must not overlap. Timestamps must be canonical UTC ISO strings. Host load must satisfy the caller's maximum and drift limits. These observations cannot detect every competing process or resource quota; control the measurement host and record its operational constraints separately.

Request counts, successful throughput and outcome percentiles are checked against raw observations. Resource peaks are checked against raw resource samples. Missing, negative, nonfinite, contradictory or insufficient samples make the result inconclusive. Older reports without comparison metadata and raw request samples must be measured again.

## Rules and interpretation

A rules file must supply all fields below. This example is a zero-variation test fixture, not a suggested real benchmark policy. Every number is an explicit caller choice. Keep the adopted file in source control with a reason based on repeated measurements and review.

```json
{
  "schemaVersion": 1,
  "reason": "Zero-variation fixture used to test regression detection.",
  "minimumRuns": 2,
  "minimumSuccesses": 5,
  "minimumOutcomeSamples": 2,
  "maxLoadAverage": 1,
  "maxLoadAverageDelta": 0,
  "limits": {
    "successLatencyMs": 0,
    "rejectionLatencyMs": 0,
    "failureLatencyMs": 0,
    "successfulPerSecond": 0,
    "failureRate": 0,
    "rejectionRate": 0,
    "rssBytesPeak": 0,
    "heapUsedBytesPeak": 0,
    "poolTotalPeak": 0,
    "poolWaitingPeak": 0,
    "uploadsActivePeak": 0,
    "uploadRejectedDelta": 0
  }
}
```

All limits are nonnegative absolute changes in the metric's units. Latency limits apply separately to p50, p95 and p99 for each operation and outcome. Rate limits use fractions, so `0.01` means one percentage point. `successfulPerSecond` limits the allowed decrease in successful requests per second. Other limits constrain increases. The tool uses the nearest-rank median of each group's per-run metrics, retains the individual run references, and reports each metric's before value, after value, change and verdict. It does not claim statistical significance.

Success, upload admission rejection and failure latencies are separate. Overall latency and attempted throughput cannot support an improvement verdict. Increasing fast rejections lowers successful throughput and increases rejection rate, each with its own limit. An outcome with zero samples in every run is omitted from latency comparison. If it appears in only some runs, or has too few samples, the comparison is inconclusive. A complete failed workload or cleanup failure produces a failed result even under permissive thresholds.

Keep the initial correctness capacity check in ordinary CI. Enable performance blocking only after reviewing repeatability on the intended measurement runner. Baseline updates need an independent explanation and reviewable report and rules diff. Local sampled resource peaks and bounded HTTP requests do not establish production cluster capacity or target deployment acceptance.
