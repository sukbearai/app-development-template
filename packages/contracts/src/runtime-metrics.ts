import { z } from "zod";

const count = z.number().int().nonnegative();
const age = z.number().nonnegative();
export const databaseMetricsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    observedAt: z.iso.datetime(),
    outbox: z.object({
      pending: count,
      processing: count,
      failed: count,
      deadLetter: count,
      published: count,
      oldestPendingAgeMs: age,
      staleLocks: count,
    }),
    tasks: z.object({
      pending: count,
      running: count,
      succeeded: count,
      failed: count,
      deadLetter: count,
      canceled: count,
      oldestUnfinishedAgeMs: age,
    }),
    quarantine: z.object({ message: count, recovery: count }),
    uploads: z.object({ pending: count, writing: count, cleanup: count, blocked: count }),
  }),
  z.object({ status: z.literal("unavailable"), observedAt: z.iso.datetime() }),
]);
export const runtimeMetricsSchema = z.object({
  version: z.literal(1),
  observedAt: z.iso.datetime(),
  process: z.object({ uptimeSeconds: age, rssBytes: count, heapUsedBytes: count }),
  databasePool: z.object({ total: count, idle: count, waiting: count, max: count }),
  uploads: z.object({ active: count, limit: count, rejectedTotal: count }),
  http: z
    .array(
      z.object({
        operationId: z.string().max(80),
        status: z.number().int().min(100).max(599),
        count,
        durationMsTotal: age,
        durationMsMax: age,
      }),
    )
    .max(512),
  database: databaseMetricsSchema,
});
export type RuntimeMetrics = z.infer<typeof runtimeMetricsSchema>;
export type DatabaseMetrics = z.infer<typeof databaseMetricsSchema>;
