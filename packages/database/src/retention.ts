import { sql } from "drizzle-orm";

import { getDatabase } from "./client";

export type RetentionOptions = {
  before: Date;
  batchSize: number;
  dryRun: boolean;
  sessionBefore?: Date;
};

export async function runRetention(options: RetentionOptions) {
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 1000 ||
    !(options.before instanceof Date) ||
    !Number.isFinite(options.before.getTime()) ||
    ![true, false].includes(options.dryRun) ||
    (options.sessionBefore !== undefined &&
      (!(options.sessionBefore instanceof Date) ||
        !Number.isFinite(options.sessionBefore.getTime()) ||
        options.sessionBefore.getTime() > Date.now()))
  )
    throw new Error("Invalid retention cutoff or batch size");
  const specs = [
    {
      key: "taskEvents",
      table: "app_task_events",
      id: "id",
      date: "created_at",
      predicate: "task_id in (select id from app_tasks where status in ('succeeded','canceled'))",
      update: null,
    },
    {
      key: "outbox",
      table: "app_outbox_events",
      id: "id",
      date: "updated_at",
      predicate: "status='published'",
      update: null,
    },
    {
      key: "telemetry",
      table: "app_telemetry_events",
      id: "id",
      date: "occurred_at",
      predicate: "true",
      update: null,
    },
    {
      key: "audit",
      table: "app_audit_logs",
      id: "id",
      date: "created_at",
      predicate: "true",
      update: null,
    },
    {
      key: "idempotency",
      table: "app_idempotency_keys",
      id: "key",
      date: "created_at",
      predicate:
        "status in ('succeeded','canceled') and request_hash ~ '^v2:[a-f0-9]{64}$' and expires_at <= now() and response_data is not null",
      update: "response_data=null",
    },
    {
      key: "receipts",
      table: "app_async_receipts",
      id: "idempotency_key",
      date: "created_at",
      predicate:
        "result <> '{}'::jsonb and idempotency_key in (select key from app_idempotency_keys where status in ('succeeded','canceled'))",
      update: "result='{}'::jsonb",
    },
  ] as const;
  return getDatabase().transaction(async (tx) => {
    const counts = {
      taskEvents: 0,
      outbox: 0,
      telemetry: 0,
      audit: 0,
      idempotency: 0,
      receipts: 0,
    };
    for (const spec of specs) {
      const selected = sql`select ${sql.identifier(spec.id)} from ${sql.identifier(spec.table)} where ${sql.identifier(spec.date)} < ${options.before} and ${sql.raw(spec.predicate)} order by ${sql.identifier(spec.date)},${sql.identifier(spec.id)} limit ${options.batchSize}`;
      if (options.dryRun) {
        const result = await tx.execute<{ count: string }>(
          sql`select count(*) from (${selected}) selected`,
        );
        counts[spec.key] = Number(result.rows[0].count);
      } else {
        const action = spec.update
          ? sql`update ${sql.identifier(spec.table)} set ${sql.raw(spec.update)} where ${sql.identifier(spec.id)} in (select ${sql.identifier(spec.id)} from selected)`
          : sql`delete from ${sql.identifier(spec.table)} where ${sql.identifier(spec.id)} in (select ${sql.identifier(spec.id)} from selected)`;
        const result = await tx.execute(
          sql`with selected as (${selected} for update skip locked) ${action} returning ${sql.identifier(spec.id)}`,
        );
        counts[spec.key] = result.rowCount ?? 0;
      }
    }
    if (options.sessionBefore === undefined) return counts;
    const selectedSessions = sql`select id from app_user_sessions
      where least(expires_at, revoked_at) < ${options.sessionBefore} and least(expires_at, revoked_at) < now()
      order by least(expires_at, revoked_at), id limit ${options.batchSize}`;
    const sessions = options.dryRun
      ? Number(
          (
            await tx.execute<{ count: string }>(
              sql`select count(*) from (${selectedSessions}) selected`,
            )
          ).rows[0].count,
        )
      : ((
          await tx.execute(sql`with selected as (${selectedSessions} for update skip locked)
          delete from app_user_sessions where id in (select id from selected) returning id`)
        ).rowCount ?? 0);
    return { ...counts, sessions };
  });
}
