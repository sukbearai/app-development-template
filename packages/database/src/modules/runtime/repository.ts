import { sql } from "drizzle-orm";

import { getDatabase, type DatabaseContext } from "../../client";

import type { AsyncQuarantineCounts } from "@pstack/contracts/outbox-health";

export async function getAdminCounts(context: DatabaseContext = getDatabase()) {
  const result = await context.execute<{
    users: string;
    audit_events: string;
    telemetry_events: string;
    files: string;
    outbox_pending: string;
  }>(sql`
    select
      (select count(*) from app_users) as users,
      (select count(*) from app_audit_logs) as audit_events,
      (select count(*) from app_telemetry_events) as telemetry_events,
      (select count(*) from app_file_assets) as files,
      (select count(*) from app_outbox_events where status = 'pending') as outbox_pending
  `);
  const row = result.rows[0];
  return {
    users: Number(row.users),
    auditEvents: Number(row.audit_events),
    telemetryEvents: Number(row.telemetry_events),
    files: Number(row.files),
    outboxPending: Number(row.outbox_pending),
  };
}

export async function getAsyncQuarantineCounts(
  context: DatabaseContext = getDatabase(),
): Promise<AsyncQuarantineCounts> {
  const result = await context.execute<{
    message_quarantine: string;
    recovery_quarantine: string;
  }>(sql`
    select
      (select count(*) from app_message_quarantine) as message_quarantine,
      (select count(*) from app_async_recovery_quarantine) as recovery_quarantine
  `);
  const row = result.rows[0];
  return {
    messageQuarantine: Number(row.message_quarantine),
    recoveryQuarantine: Number(row.recovery_quarantine),
  };
}

export async function getAsyncRuntimeHealthRows(
  context: DatabaseContext = getDatabase(),
  staleBefore = new Date(Date.now() - 300000),
) {
  const [outbox, tasks, quarantine] = await Promise.all([
    context.execute<{
      topic: string;
      status: string;
      count: string;
      oldest: Date | string;
      stale: string;
    }>(sql`
      select topic,status,count(*) as count,min(created_at) as oldest,
        count(*) filter (where status='processing' and locked_at < ${staleBefore}) as stale
      from app_outbox_events group by topic,status`),
    context.execute<{ status: string; count: string }>(
      sql`select status,count(*) as count from app_tasks group by status`,
    ),
    getAsyncQuarantineCounts(context),
  ]);
  return {
    quarantine,
    outboxEvents: outbox.rows.map((row) => ({
      topic: row.topic,
      status: row.status,
      count: Number(row.count),
      createdAt: new Date(row.oldest),
      staleCount: Number(row.stale),
    })),
    tasks: tasks.rows.map((row) => ({
      status: row.status,
      count: Number(row.count),
    })),
  };
}
