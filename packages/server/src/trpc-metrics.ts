import type { RuntimeMetrics } from "@pstack/contracts/runtime-metrics";

const procedures = new Set([
  "auth.login",
  "auth.me",
  "auth.logout",
  "auth.changePassword",
  "users.list",
  "users.create",
  "users.update",
  "users.resetPassword",
  "roles.list",
  "roles.create",
  "roles.update",
  "audit.list",
  "outbox.list",
  "runtime.health",
]);
const statuses = new Set([200, 400, 401, 403, 404, 405, 409, 413, 415, 429, 500, 503]);
const counters = new Map<string, RuntimeMetrics["http"][number]>();

export function rpcProcedurePath(pathname: string) {
  const path = pathname.slice("/api/trpc/".length);
  return pathname.startsWith("/api/trpc/") && procedures.has(path) ? path : undefined;
}

export function recordRpcMetric(pathname: string, status: number, durationMs: number) {
  const procedure = rpcProcedurePath(pathname);
  if (!procedure || !statuses.has(status)) return;
  const operationId = `trpc.${procedure}`;
  const key = `${operationId}:${status}`;
  const metric = counters.get(key) ?? {
    operationId,
    status,
    count: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
  };
  metric.count++;
  metric.durationMsTotal += durationMs;
  metric.durationMsMax = Math.max(metric.durationMsMax, durationMs);
  counters.set(key, metric);
}

export function rpcMetricsSnapshot() {
  return [...counters.values()].map((metric) => ({ ...metric }));
}
