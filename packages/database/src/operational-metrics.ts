import { sql } from "drizzle-orm";
import { z } from "zod";
import { databaseMetricsSchema } from "@pstack/contracts/runtime-metrics";
import { getDatabase, type DatabaseContext } from "./client";

const resultSchema = z.array(z.object({ snapshot: databaseMetricsSchema })).length(1);

export async function readDatabaseMetrics(context: DatabaseContext = getDatabase()) {
  const result = await context.execute(sql`
    select jsonb_build_object(
      'status', 'available',
      'observedAt', to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'outbox', (select jsonb_build_object(
        'pending', count(*) filter (where status='pending'),
        'processing', count(*) filter (where status='processing'),
        'failed', count(*) filter (where status='failed'),
        'deadLetter', count(*) filter (where status='dead_letter'),
        'published', count(*) filter (where status='published'),
        'oldestPendingAgeMs', greatest(0, coalesce(extract(epoch from
          (statement_timestamp()-min(created_at) filter (where status in ('pending','failed'))))*1000,0)),
        'staleLocks', count(*) filter (where status='processing'
          and coalesce(lease_until, locked_at, '-infinity'::timestamptz) <= statement_timestamp())
      ) from app_outbox_events),
      'tasks', (select jsonb_build_object(
        'pending', count(*) filter (where status='pending'),
        'running', count(*) filter (where status='running'),
        'succeeded', count(*) filter (where status='succeeded'),
        'failed', count(*) filter (where status='failed'),
        'deadLetter', count(*) filter (where status='dead_letter'),
        'canceled', count(*) filter (where status='canceled'),
        'oldestUnfinishedAgeMs', greatest(0, coalesce(extract(epoch from
          (statement_timestamp()-min(created_at) filter (where status in ('pending','running','failed'))))*1000,0))
      ) from app_tasks),
      'quarantine', jsonb_build_object(
        'message', (select count(*) from app_message_quarantine),
        'recovery', (select count(*) from app_async_recovery_quarantine)),
      'uploads', (select jsonb_build_object(
        'pending', count(*) filter (where state='pending'),
        'writing', count(*) filter (where state='writing'),
        'cleanup', count(*) filter (where state='cleanup'),
        'blocked', count(*) filter (where state='blocked')
      ) from app_upload_intents)
    ) as snapshot
  `);
  return resultSchema.parse(result.rows)[0].snapshot;
}
