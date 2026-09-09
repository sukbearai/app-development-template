import { apiOperations, type ApiOperationId } from "@pstack/contracts/http";
import type { RuntimeMetrics } from "@pstack/contracts/runtime-metrics";

const counters = new Map(
  apiOperations
    .filter((operation) => operation.operationId !== "getApiSystemMetrics")
    .flatMap((operation) =>
      Object.keys(operation.responses).map((status) => {
        const metric: RuntimeMetrics["http"][number] = {
          operationId: operation.operationId,
          status: Number(status),
          count: 0,
          durationMsTotal: 0,
          durationMsMax: 0,
        };
        return [`${operation.operationId}:${status}`, metric] as const;
      }),
    ),
);

export function recordHttpMetric(operationId: ApiOperationId, status: number, durationMs: number) {
  if (operationId === "getApiSystemMetrics") return;
  const metric = counters.get(`${operationId}:${status}`);
  if (!metric) return;
  metric.count++;
  metric.durationMsTotal += durationMs;
  metric.durationMsMax = Math.max(metric.durationMsMax, durationMs);
}
export function httpMetricsSnapshot() {
  return [...counters.values()].map((metric) => ({ ...metric }));
}
