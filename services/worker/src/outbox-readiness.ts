import pg from "pg";
import {
  evaluateOutboxBacklog,
  readOutboxHealthThresholds,
  statusFromOutboxAlerts,
  type OutboxBacklogMetrics,
  type OutboxHealthAlert,
  type OutboxHealthThresholds,
} from "@pstack/contracts/outbox-health";
import type { OutboxWorkerOptions } from "./outbox";

export type OutboxAlert = OutboxHealthAlert;

type OutboxReadinessInput = OutboxBacklogMetrics & OutboxHealthThresholds & {
  deadLetter: number;
  staleLocks: number;
};

export type OutboxReadiness = {
  service: "worker";
  status: "ok" | "degraded" | "blocked";
  mode: "outbox_observer";
  backlog: {
    pending: number;
    failed: number;
    processing: number;
    deadLetter: number;
    readyToRetry: number;
    totalRetryable: number;
  };
  oldestPendingAgeMs: number;
  staleLocks: {
    thresholdMs: number;
    count: number;
    eventIds: string[];
  };
  thresholds: OutboxHealthThresholds;
  blockedReasons: string[];
  alerts: OutboxAlert[];
  checkedAt: string;
};

function numberOption(
  value: number | undefined,
  envName: string,
  fallback: number,
) {
  return value ?? Number(process.env[envName] || fallback);
}

export function outboxReadinessStatus(input: OutboxReadinessInput) {
  return statusFromOutboxAlerts(buildOutboxAlerts(input));
}

export function buildOutboxAlerts(input: OutboxReadinessInput) {
  const alerts: OutboxAlert[] = [];
  if (input.deadLetter > 0) {
    alerts.push({
      severity: "critical",
      reason: "outbox_dead_letter",
      message:
        "Outbox events reached dead letter state and require investigation.",
      metric: "deadLetter",
      value: input.deadLetter,
      threshold: 1,
    });
  }
  alerts.push(...evaluateOutboxBacklog(input, input));
  if (input.staleLocks > 0) {
    alerts.push({
      severity: "warning",
      reason: "outbox_stale_processing_lock",
      message: "Outbox processing locks exceeded the stale lock threshold.",
      metric: "staleLocks",
      value: input.staleLocks,
      threshold: 1,
    });
  }
  return alerts;
}

export async function inspectOutboxReadiness(
  options: OutboxWorkerOptions & {
    pendingWarn?: number;
    pendingBlocked?: number;
    failedWarn?: number;
    staleLockMs?: number;
  } = {},
): Promise<OutboxReadiness> {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const defaults = readOutboxHealthThresholds(process.env);
  const pendingWarn = options.pendingWarn ?? defaults.pendingWarn;
  const pendingBlocked = options.pendingBlocked ?? defaults.pendingBlocked;
  const failedWarn = options.failedWarn ?? defaults.failedWarn;
  const staleLockMs = numberOption(
    options.staleLockMs,
    "OUTBOX_STALE_LOCK_MS",
    5 * 60 * 1000,
  );
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const [statusCounts, oldestPending, staleLocks] = await Promise.all([
      pool.query(
        "SELECT status, count(*)::int AS count, count(*) FILTER (WHERE next_attempt_at <= now())::int AS due FROM app_outbox_events GROUP BY status",
      ),
      pool.query(
        "SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) * 1000 AS age_ms FROM app_outbox_events WHERE status IN ('pending', 'failed')",
      ),
      pool.query(
        `
        SELECT id, count(*) OVER()::int AS total
        FROM app_outbox_events
        WHERE status = 'processing'
          AND COALESCE(lease_until, locked_at + ($1::int * interval '1 millisecond'), '-infinity'::timestamptz) <= now()
        ORDER BY locked_at ASC
        LIMIT 20
      `,
        [staleLockMs],
      ),
    ]);
    const countByStatus = new Map(
      statusCounts.rows.map((row) => [
        String(row.status),
        Number(row.count || 0),
      ]),
    );
    const pending = countByStatus.get("pending") || 0;
    const failed = countByStatus.get("failed") || 0;
    const processing = countByStatus.get("processing") || 0;
    const deadLetter = countByStatus.get("dead_letter") || 0;
    const oldestPendingAgeMs = Math.max(
      0,
      Math.round(Number(oldestPending.rows[0]?.age_ms || 0)),
    );
    const staleLockIds = staleLocks.rows.map((row) => String(row.id));
    const statusInput = {
      pending,
      failed,
      deadLetter,
      staleLocks: Number(staleLocks.rows[0]?.total ?? 0),
      oldestPendingAgeMs,
      pendingWarn,
      pendingBlocked,
      failedWarn,
    };
    const alerts = buildOutboxAlerts(statusInput);
    return {
      service: "worker",
      status: statusFromOutboxAlerts(alerts),
      mode: "outbox_observer",
      backlog: {
        pending,
        failed,
        processing,
        deadLetter,
        readyToRetry: statusCounts.rows
          .filter((row) => row.status === "pending" || row.status === "failed")
          .reduce((sum, row) => sum + Number(row.due), 0),
        totalRetryable: pending + failed + processing,
      },
      oldestPendingAgeMs,
      staleLocks: {
        thresholdMs: staleLockMs,
        count: Number(staleLocks.rows[0]?.total ?? 0),
        eventIds: staleLockIds,
      },
      thresholds: { pendingWarn, pendingBlocked, failedWarn },
      blockedReasons: alerts.map((alert) => alert.reason),
      alerts,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
