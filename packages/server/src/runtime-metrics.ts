import { databasePoolSnapshot } from "@pstack/database/client";
import { readDatabaseMetrics } from "@pstack/database/operational-metrics";
import type { DatabaseMetrics, RuntimeMetrics } from "@pstack/contracts/runtime-metrics";
import { httpMetricsSnapshot } from "./http-metrics";
import { uploadAdmissionSnapshot } from "./upload-admission";

const databaseCacheMs = 1000;
let cached: { value: DatabaseMetrics; expiresAt: number } | undefined;
let pending: Promise<DatabaseMetrics> | undefined;

async function observeDatabase(): Promise<DatabaseMetrics> {
  let value: DatabaseMetrics;
  try {
    value = await readDatabaseMetrics();
  } catch {
    value = { status: "unavailable", observedAt: new Date().toISOString() };
  }
  cached = { value, expiresAt: performance.now() + databaseCacheMs };
  return value;
}
function databaseSnapshot(): Promise<DatabaseMetrics> {
  if (cached && performance.now() < cached.expiresAt) return Promise.resolve(cached.value);
  pending ??= observeDatabase().finally(() => { pending = undefined; });
  return pending;
}
export async function runtimeMetricsSnapshot(): Promise<RuntimeMetrics> {
  const database = await databaseSnapshot();
  const memory = process.memoryUsage();
  return {
    version: 1, observedAt: new Date().toISOString(),
    process: { uptimeSeconds: process.uptime(), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
    databasePool: databasePoolSnapshot(), uploads: uploadAdmissionSnapshot(),
    http: httpMetricsSnapshot(), database,
  };
}
