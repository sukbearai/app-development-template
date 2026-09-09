import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireProductionLock,
  ownedCapacityTarget,
  refuseCapacityEnvFiles,
  verificationOptions,
} from "../capacity-options.mjs";
import {
  parseCapacityResponse,
  responseOutcome,
  summarizeMetrics,
  summarizeRequests,
} from "../capacity-summary.mjs";

const capacityArgs = ["--production", "--capacity"];
test("capacity parser has bounded defaults and keeps existing modes", () => {
  assert.deepEqual(verificationOptions(capacityArgs), {
    production: true,
    mode: "capacity",
    capacity: { concurrency: 4, requests: 24, uploadBytes: 262144 },
  });
  assert.equal(verificationOptions([]).mode, "api");
  assert.equal(verificationOptions(["--production", "--ui"]).mode, "ui");
  assert.equal(
    verificationOptions([
      ...capacityArgs,
      "--requests",
      "1000",
      "--concurrency",
      "64",
      "--upload-bytes",
      "1024",
    ]).capacity.requests,
    1000,
  );
});
test("capacity parser rejects incompatible modes, external targets and oversized runs", () => {
  for (const args of [
    ["--capacity"],
    [...capacityArgs, "--ui"],
    ["--requests", "1"],
    [...capacityArgs, "--url", "https://example.com"],
    [...capacityArgs, "--database-url", "postgresql://example.com/app"],
    [...capacityArgs, "--requests", "0"],
    [...capacityArgs, "--requests", "1001"],
    [...capacityArgs, "--requests", "1e2"],
    [...capacityArgs, "--concurrency", "65"],
    [...capacityArgs, "--upload-bytes", "10485761"],
    [...capacityArgs, "--requests", "1000", "--upload-bytes", "10485760"],
  ])
    assert.throws(() => verificationOptions(args));
});
test("invalid CLI arguments exit before evidence or resource setup", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-app.mjs", "--capacity"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --production/);
  assert.doesNotMatch(result.stdout, /Evidence:/);
});
test("capacity targets must have exact owned loopback shape", () => {
  const origin = "http://127.0.0.1:45678";
  const database = "postgresql://postgres:generated@127.0.0.1:45679/pstack_test";
  ownedCapacityTarget(origin, database);
  for (const unsafe of [
    "https://example.com",
    "http://localhost:45678",
    `${origin}/other`,
    `${origin}?target=x`,
    "http://user:password@127.0.0.1:45678",
  ])
    assert.throws(() => ownedCapacityTarget(unsafe, database));
  for (const unsafe of [
    database.replace("127.0.0.1", "example.com"),
    database.replace("pstack_test", "shared"),
    database + "?host=example.com",
  ])
    assert.throws(() => ownedCapacityTarget(origin, unsafe));
});
test("production lock rejects another owner and can only be reacquired after release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capacity-lock-"));
  try {
    const release = await acquireProductionLock(root);
    await assert.rejects(acquireProductionLock(root), /already owns/);
    assert.equal(
      JSON.parse(
        await readFile(path.join(root, ".verification/production-verification.lock"), "utf8"),
      ).pid,
      process.pid,
    );
    await release();
    await (
      await acquireProductionLock(root)
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("capacity refuses dotenv fallback in either loader root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capacity-env-"));
  try {
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    await writeFile(path.join(root, ".env.example"), "DATABASE_URL=example");
    await refuseCapacityEnvFiles(root);
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      ".env.test.local",
    ]) {
      const file = path.join(root, "apps/web", name);
      await writeFile(file, "DATABASE_URL=must-not-load");
      await assert.rejects(refuseCapacityEnvFiles(root), /dotenv/);
      await rm(file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("summary distinguishes admission rejection and failures, with nearest rank percentiles", () => {
  const summary = summarizeRequests(
    [
      { durationMs: 20, outcome: "success" },
      { durationMs: 10, outcome: "upload_busy" },
      { durationMs: 30, outcome: "failed" },
    ],
    1000,
  );
  const { responses, failureObservations, omittedFailures, ...measurements } = summary;
  assert.equal(
    responses.reduce((sum, entry) => sum + entry.count, 0),
    3,
  );
  assert.equal(failureObservations.length, 1);
  assert.equal(omittedFailures, 0);
  assert.deepEqual(measurements, {
    issued: 3,
    successful: 1,
    uploadBusy: 1,
    failed: 1,
    elapsedMs: 1000,
    requestsPerSecond: 3,
    successfulPerSecond: 1,
    latencyMs: { p50: 20, p95: 30, p99: 30 },
    latencyMsByOutcome: {
      success: { p50: 20, p95: 20, p99: 20 },
      upload_busy: { p50: 10, p95: 10, p99: 10 },
      failed: { p50: 30, p95: 30, p99: 30 },
    },
  });
  assert.equal(summarizeRequests([], 0).latencyMs.p99, null);
  assert.equal(summarizeMetrics([]).rssBytesPeak, null);
});
test("only upload 503 UPLOAD_BUSY with retry instructions is expected shedding", () => {
  const busy = new Response(null, { status: 503, headers: { "retry-after": "1" } });
  assert.equal(
    responseOutcome("upload", busy, {
      traceId: "trace_capacity_test",
      error: { code: "UPLOAD_BUSY", message: "Upload slots occupied" },
    }),
    "upload_busy",
  );
  assert.equal(
    responseOutcome("read", busy, {
      traceId: "trace_capacity_test",
      error: { code: "UPLOAD_BUSY", message: "Upload slots occupied" },
    }),
    "failed",
  );
  assert.equal(
    responseOutcome("upload", busy, {
      traceId: "trace_capacity_test",
      error: { code: "DATABASE_ERROR", message: "Database unavailable" },
    }),
    "failed",
  );
  assert.equal(
    responseOutcome("upload", new Response(null, { status: 503 }), {
      traceId: "trace_capacity_test",
      error: { code: "UPLOAD_BUSY", message: "Upload slots occupied" },
    }),
    "failed",
  );
  assert.equal(
    responseOutcome("read", new Response(null, { status: 200 }), {
      traceId: "trace_capacity_test",
      data: [],
    }),
    "success",
  );
});

test("capacity rejects malformed successful envelopes using canonical operation contracts", () => {
  const wrap = (data) => ({ traceId: "trace_capacity_test", data });
  const response = new Response(null, { status: 200 });
  for (const operation of ["login", "read", "upload"]) {
    assert.equal(responseOutcome(operation, response, wrap(123)), "failed");
    assert.throws(() => parseCapacityResponse(operation, 200, wrap(123)));
  }
  assert.equal(responseOutcome("write", new Response(null, { status: 201 }), wrap(123)), "failed");
  assert.throws(() => parseCapacityResponse("metrics", 200, wrap({ version: 1 })));
  assert.equal(responseOutcome("read", response, wrap([{ id: "role_1" }])), "failed");
  assert.deepEqual(parseCapacityResponse("read", 200, wrap([])), wrap([]));
});

test("fast admission rejections cannot hide successful upload tail latency", () => {
  const observations = Array.from({ length: 99 }, () => ({
    outcome: "upload_busy",
    durationMs: 1,
  }));
  observations.push({ outcome: "success", durationMs: 500 });
  const summary = summarizeRequests(observations, 1000);
  assert.equal(summary.latencyMs.p95, 1);
  assert.equal(summary.latencyMsByOutcome.success.p95, 500);
  assert.equal(summary.latencyMsByOutcome.upload_busy.p95, 1);
  assert.deepEqual(summary.latencyMsByOutcome.failed, { p50: null, p95: null, p99: null });
});

test("CLI parsing never echoes secret positional URLs or unknown flag values", async () => {
  const sentinel = "CAPACITY_SENTINEL_SECRET";
  const target = `postgresql://app:${sentinel}@db/app`;
  const evidence = new URL("../../.verification/app/", import.meta.url);
  const directories = async () => {
    try {
      return (await readdir(evidence)).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const before = await directories();
  for (const args of [
    [target],
    [`--${sentinel}`, target],
    [`--url=${target}`],
    ["--requests", target],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-app.mjs", ...capacityArgs, ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\/|Evidence:/);
    assert.match(result.stderr, /Invalid verification arguments|must be an integer/);
  }
  assert.deepEqual(await directories(), before);
});
