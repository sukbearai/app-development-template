import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { capacityFailure, readCapacityResponse } from "./capacity-diagnostics.mjs";
import { ownedCapacityTarget } from "./capacity-options.mjs";
import {
  assessCapacityResponse,
  parseCapacityResponse,
  summarizeMetrics,
  summarizeRequests,
} from "./capacity-summary.mjs";
import { verifyCapacityOverload } from "./capacity-overload.mjs";

export async function runCapacityWorkload({ env, options, signal }) {
  ownedCapacityTarget(env.APP_ORIGIN, env.DATABASE_URL);
  const report = {
    version: 1,
    status: "failed",
    startedAt: new Date().toISOString(),
    options,
    operations: {},
    metrics: {},
    persistence: null,
    overload: null,
  };
  const samples = [];
  const writes = [];
  const uploads = [];
  const control = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
    query_timeout: 16000,
  });
  const bytes = new Uint8Array(options.uploadBytes).fill(120);
  const prefix = `capacity_${randomUUID()}`;
  let token;
  let samplingError = false;
  let stage = "connect";
  const samplerAbort = new AbortController();
  let sampler;
  async function call(route, init = {}) {
    signal.throwIfAborted();
    const response = await fetch(new URL(route, env.APP_ORIGIN), {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    return readCapacityResponse(response);
  }
  async function sample() {
    const { response, payload } = await call("/api/system/metrics", {
      headers: { authorization: `Bearer ${env.METRICS_TOKEN}` },
    });
    assert.equal(response.status, 200, "Metrics request failed");
    const metric = parseCapacityResponse("metrics", response.status, payload).data;
    assert.equal(metric.database.status, "available", "Metrics database unavailable");
    assert.ok(
      metric.uploads.limit >= 1 && metric.uploads.limit <= 64,
      "Metrics upload limit invalid",
    );
    samples.push({
      observedAt: metric.observedAt,
      process: metric.process,
      databasePool: metric.databasePool,
      uploads: metric.uploads,
    });
    return metric;
  }
  function upload(filename, contents) {
    const body = new FormData();
    body.set("file", new File([contents], filename, { type: "text/plain" }));
    return call("/api/uploads", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    });
  }
  async function issue(operation, index) {
    if (operation === "upload") return upload(`${prefix}_${index}.txt`, bytes);
    const login = operation === "login";
    const role = {
      id: `${prefix}_${index}`,
      name: "Capacity reader",
      status: "active",
      permissionIds: ["admin.read"],
    };
    const headers = {};
    if (!login) headers.authorization = `Bearer ${token}`;
    if (operation !== "read") headers["content-type"] = "application/json";
    return call(login ? "/api/auth/login" : "/api/admin/roles", {
      method: operation === "read" ? "GET" : "POST",
      headers,
      body:
        operation === "read"
          ? undefined
          : JSON.stringify(
              login
                ? { account: env.UI_FLOW_ADMIN_ACCOUNT, password: env.UI_FLOW_ADMIN_PASSWORD }
                : role,
            ),
    });
  }
  async function phase(operation) {
    const observations = [];
    let next = 0;
    const started = performance.now();
    const workers = Array.from(
      { length: Math.min(options.concurrency, options.requests) },
      async () => {
        while (next < options.requests && !signal.aborted && !samplingError) {
          const index = next++;
          const start = performance.now();
          let outcome = "failed";
          let status = null;
          let diagnostic;
          let requestStage = "request";
          try {
            const received = await issue(operation, index);
            const { response, payload } = received;
            status = response.status;
            const assessment = received.diagnostic
              ? { outcome: "failed", diagnostic: received.diagnostic }
              : assessCapacityResponse(operation, response, payload);
            outcome = assessment.outcome;
            diagnostic = assessment.diagnostic;
            requestStage = "assertion";
            if (outcome === "success") {
              if (operation === "login") {
                token = payload.data.token;
              }
              if (operation === "write") {
                assert.equal(
                  payload.data.id,
                  `${prefix}_${index}`,
                  "Created role identity mismatch",
                );
                writes.push(payload.data.id);
              }
              if (operation === "upload") {
                uploads.push({
                  id: payload.data.id,
                  storageKey: payload.data.storageKey,
                  filename: `${prefix}_${index}.txt`,
                });
              }
            }
          } catch (error) {
            outcome = "failed";
            diagnostic = capacityFailure(requestStage, error);
          }
          observations.push({
            operation,
            index,
            outcome,
            status,
            diagnostic,
            durationMs: performance.now() - start,
          });
        }
      },
    );
    await Promise.all(workers);
    report.operations[operation] = {
      ...summarizeRequests(observations, performance.now() - started),
      observations,
    };
    assert.equal(observations.length, options.requests, "Workload issuance stopped");
    assert.equal(
      report.operations[operation].failed,
      0,
      "Unexpected workload response or deadline failure",
    );
    assert.ok(report.operations[operation].successful > 0, "Workload had no successful responses");
  }
  try {
    await control.connect();
    const initial = await control.query(
      "SELECT (SELECT count(*)::int FROM app_roles) AS roles, (SELECT count(*)::int FROM app_file_assets) AS files",
    );
    report.data = { initialRoles: initial.rows[0].roles, initialFiles: initial.rows[0].files };
    await sample();
    sampler = (async () => {
      try {
        while (!samplerAbort.signal.aborted && !signal.aborted) {
          await delay(200, undefined, { signal: AbortSignal.any([samplerAbort.signal, signal]) });
          await sample();
        }
      } catch {
        if (!samplerAbort.signal.aborted && !signal.aborted) samplingError = true;
      }
    })();
    for (const operation of ["login", "read", "write", "upload"]) {
      stage = operation;
      await phase(operation);
    }
    stage = "overload";
    report.overload = await verifyCapacityOverload({
      base: env.APP_ORIGIN,
      token,
      signal,
      sample,
      upload,
    });
    stage = "persistence";
    const roles = await control.query(
      "SELECT id, name, status FROM app_roles WHERE id = ANY($1::text[])",
      [writes],
    );
    assert.equal(roles.rowCount, writes.length, "Successful role writes must persist");
    for (const role of roles.rows) {
      assert.equal(role.name, "Capacity reader");
      assert.equal(role.status, "active");
    }
    for (const uploadRecord of uploads) {
      signal.throwIfAborted();
      const result = await control.query(
        "SELECT f.storage_key, f.file_name, f.size_bytes, i.state FROM app_file_assets f JOIN app_upload_intents i ON i.storage_key=f.storage_key WHERE f.id=$1",
        [uploadRecord.id],
      );
      assert.equal(result.rowCount, 1, "Successful upload must persist");
      const file = result.rows[0];
      assert.equal(file.storage_key, uploadRecord.storageKey);
      assert.equal(file.file_name, uploadRecord.filename);
      assert.equal(Number(file.size_bytes), options.uploadBytes);
      assert.equal(file.state, "committed");
      const location = path.resolve(env.UPLOAD_STORAGE_DIR, file.storage_key);
      assert.ok(
        location.startsWith(path.resolve(env.UPLOAD_STORAGE_DIR) + path.sep),
        "Upload storage path escaped owned directory",
      );
      assert.deepEqual(await readFile(location), Buffer.from(bytes));
      const outbox = await control.query(
        "SELECT count(*)::int AS n FROM app_outbox_events WHERE payload->>'fileId'=$1",
        [uploadRecord.id],
      );
      assert.equal(outbox.rows[0].n, 1, "Uploaded file must have one durable outbox fact");
    }
    report.persistence = {
      roles: roles.rowCount,
      files: uploads.length,
      localFileBytes: uploads.length * options.uploadBytes,
      committedIntents: uploads.length,
      uploadOutboxFacts: uploads.length,
    };
    await sample();
    assert.equal(samplingError, false, "Metrics sampling failed");
    report.status = "passed";
  } catch {
    report.error = signal.aborted ? "interrupted" : `capacity_${stage}_failed`;
  } finally {
    samplerAbort.abort();
    await sampler;
    if (samplingError) {
      report.status = "failed";
      report.error = "capacity_metrics_failed";
    }
    await control.end().catch(() => {
      report.status = "failed";
      report.error = "capacity_database_cleanup_failed";
    });
    report.metrics = summarizeMetrics(samples);
    report.metricSamples = samples;
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
