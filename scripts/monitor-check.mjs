#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const { runtimeMetricsSchema } = await tsImport("../packages/contracts/src/runtime-metrics.ts", import.meta.url);
const { apiSuccessSchema } = await tsImport("../packages/contracts/src/http.ts", import.meta.url);
const metricsResponseSchema = apiSuccessSchema(runtimeMetricsSchema);
const responseLimit = 256 * 1024;
const settings = {
  timeoutMs: ["MONITOR_TIMEOUT_MS", 5000, 100, 60000],
  maxAgeMs: ["MONITOR_MAX_AGE_MS", 60000, 1000, 3600000],
  poolWaiting: ["MONITOR_POOL_WAITING", 1, 1, 1000000],
  outboxAgeMs: ["MONITOR_OUTBOX_AGE_MS", 300000, 1, 2592000000],
  outboxStaleLocks: ["MONITOR_OUTBOX_STALE_LOCKS", 1, 1, 1000000000],
  taskAgeMs: ["MONITOR_TASK_AGE_MS", 900000, 1, 2592000000],
  deadLetters: ["MONITOR_DEAD_LETTERS", 1, 1, 1000000000],
  quarantine: ["MONITOR_QUARANTINE", 1, 1, 1000000000],
  blockedUploads: ["MONITOR_BLOCKED_UPLOADS", 1, 1, 1000000000],
};

export function monitorConfig(env, argv = []) {
  if (argv.some((arg) => arg !== "--")) throw new Error("invalid_configuration");
  const url = new URL(env.METRICS_URL);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/api/system/metrics") {
    throw new Error("invalid_configuration");
  }
  const token = env.METRICS_TOKEN || "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("invalid_configuration");
  const config = { url, token };
  for (const [key, [variable, fallback, minimum, maximum]] of Object.entries(settings)) {
    const raw = env[variable] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error("invalid_configuration");
    }
    config[key] = value;
  }
  return config;
}

function result(severity, reasons) {
  return { version: 1, severity, reasons };
}

export function evaluateMetrics(metrics, config, now = Date.now()) {
  const reasons = [];
  for (const [timestamp, stale, future] of [
    [metrics.observedAt, "metrics_stale", "metrics_clock_ahead"],
    [metrics.database.observedAt, "database_metrics_stale", "database_metrics_clock_ahead"],
  ]) {
    const ageMs = now - Date.parse(timestamp);
    if (!Number.isFinite(ageMs) || ageMs > config.maxAgeMs) reasons.push(stale);
    if (ageMs < -5000) reasons.push(future);
  }
  if (metrics.databasePool.waiting >= config.poolWaiting) reasons.push("database_pool_waiting");
  const database = metrics.database;
  if (database.status === "unavailable") reasons.push("database_unavailable");
  else {
    const conditions = [
      [database.outbox.oldestPendingAgeMs, config.outboxAgeMs, "outbox_pending_age"],
      [database.outbox.staleLocks, config.outboxStaleLocks, "outbox_stale_locks"],
      [database.tasks.oldestUnfinishedAgeMs, config.taskAgeMs, "task_unfinished_age"],
      [database.outbox.deadLetter + database.tasks.deadLetter, config.deadLetters, "dead_letters"],
      [database.quarantine.message + database.quarantine.recovery, config.quarantine, "quarantine"],
      [database.uploads.blocked, config.blockedUploads, "uploads_blocked"],
    ];
    for (const [value, threshold, reason] of conditions) if (value >= threshold) reasons.push(reason);
  }
  return result(reasons.length ? "alert" : "healthy", reasons);
}

async function readMetrics(response) {
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new Error("invalid_response");
  }
  if (Number(response.headers.get("content-length")) > responseLimit) throw new Error("invalid_response");
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) throw new Error("invalid_response");
      chunks.push(value);
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return metricsResponseSchema.parse(parsed).data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function checkMonitor(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      redirect: "error", signal: controller.signal,
    });
    if (!response.ok) return result("error", ["metrics_http_error"]);
    try {
      return evaluateMetrics(await readMetrics(response), config);
    } catch {
      return result("error", [controller.signal.aborted ? "metrics_timeout" : "metrics_invalid_response"]);
    }
  } catch {
    return result("error", [controller.signal.aborted ? "metrics_timeout" : "metrics_request_failed"]);
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  let config;
  try {
    config = monitorConfig(env, argv);
  } catch {
    return { output: result("error", ["invalid_configuration"]), exitCode: 2 };
  }
  const output = await checkMonitor(config);
  return { output, exitCode: output.severity === "healthy" ? 0 : 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, exitCode } = await main();
  console.log(JSON.stringify(output));
  process.exitCode = exitCode;
}
