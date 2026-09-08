import { z } from "zod";

const outboxHealthThresholdsSchema = z.object({
  pendingWarn: z.coerce.number().int().positive().catch(50),
  pendingBlocked: z.coerce.number().int().positive().catch(200),
  failedWarn: z.coerce.number().int().positive().catch(10),
});

export type OutboxHealthThresholds = z.infer<typeof outboxHealthThresholdsSchema>;

export type OutboxBacklogMetrics = {
  pending: number;
  failed: number;
  oldestPendingAgeMs: number;
};

export type AsyncQuarantineCounts = {
  messageQuarantine: number;
  recoveryQuarantine: number;
};

export type OutboxHealthAlert = {
  severity: "warning" | "critical";
  reason: string;
  message: string;
  metric: string;
  value: number;
  threshold?: number;
};

export const OUTBOX_RETRY_AGE_WARN_MS = 32_000;

export function readOutboxHealthThresholds(
  env: Record<string, string | undefined>,
): OutboxHealthThresholds {
  return outboxHealthThresholdsSchema.parse({
    pendingWarn: env.OUTBOX_PENDING_WARN,
    pendingBlocked: env.OUTBOX_PENDING_BLOCKED,
    failedWarn: env.OUTBOX_FAILED_WARN,
  });
}

export function statusFromOutboxAlerts(
  alerts: readonly Pick<OutboxHealthAlert, "severity">[],
): "ok" | "degraded" | "blocked" {
  return alerts.some((alert) => alert.severity === "critical")
    ? "blocked"
    : alerts.length
      ? "degraded"
      : "ok";
}

export function evaluateOutboxBacklog(
  metrics: OutboxBacklogMetrics,
  thresholds: OutboxHealthThresholds,
): OutboxHealthAlert[] {
  const alerts: OutboxHealthAlert[] = [];
  if (metrics.pending >= thresholds.pendingBlocked) {
    alerts.push({
      severity: "critical",
      reason: "outbox_pending_blocked",
      message: "Outbox pending backlog reached the blocked threshold.",
      metric: "pending",
      value: metrics.pending,
      threshold: thresholds.pendingBlocked,
    });
  } else if (metrics.pending >= thresholds.pendingWarn) {
    alerts.push({
      severity: "warning",
      reason: "outbox_pending_backlog",
      message: "Outbox pending backlog reached the warning threshold.",
      metric: "pending",
      value: metrics.pending,
      threshold: thresholds.pendingWarn,
    });
  }
  if (metrics.failed >= thresholds.failedWarn) {
    alerts.push({
      severity: "warning",
      reason: "outbox_failed_backlog",
      message: "Outbox failed retry backlog reached the warning threshold.",
      metric: "failed",
      value: metrics.failed,
      threshold: thresholds.failedWarn,
    });
  }
  if (metrics.oldestPendingAgeMs >= OUTBOX_RETRY_AGE_WARN_MS) {
    alerts.push({
      severity: "warning",
      reason: "outbox_oldest_pending_age",
      message:
        "Oldest retryable outbox event has waited longer than the retry-age warning threshold.",
      metric: "oldestPendingAgeMs",
      value: metrics.oldestPendingAgeMs,
      threshold: OUTBOX_RETRY_AGE_WARN_MS,
    });
  }
  return alerts;
}

export function evaluateAsyncQuarantine(
  counts: AsyncQuarantineCounts,
): OutboxHealthAlert[] {
  const alerts: OutboxHealthAlert[] = [];
  if (counts.messageQuarantine > 0) {
    alerts.push({
      severity: "critical",
      reason: "async_message_quarantine",
      message:
        "Isolated async message records are retained and require investigation.",
      metric: "messageQuarantine",
      value: counts.messageQuarantine,
      threshold: 1,
    });
  }
  if (counts.recoveryQuarantine > 0) {
    alerts.push({
      severity: "critical",
      reason: "async_recovery_quarantine",
      message:
        "Isolated async recovery records are retained and require investigation.",
      metric: "recoveryQuarantine",
      value: counts.recoveryQuarantine,
      threshold: 1,
    });
  }
  return alerts;
}
