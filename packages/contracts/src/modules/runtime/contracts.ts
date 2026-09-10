import { z } from "zod";

import {
  nonEmptyStringSchema,
  optionalNonEmptyStringSchema,
  isoDateTimeSchema,
} from "../../primitives.ts";

export const adminSummarySchema = z.object({
  users: z.number().int().nonnegative(),
  auditEvents: z.number().int().nonnegative(),
  telemetryEvents: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  outboxPending: z.number().int().nonnegative(),
});

export const asyncRuntimeHealthAlertSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  reason: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  metric: optionalNonEmptyStringSchema,
  value: z.number().optional(),
  threshold: z.number().optional(),
  topic: optionalNonEmptyStringSchema,
});

export const asyncRuntimePlanSchema = z.object({
  outboxIntervalMs: z.number().int().nonnegative(),
  topics: z.array(nonEmptyStringSchema),
  publisher: nonEmptyStringSchema,
  kafka: z.object({
    brokersConfigured: z.number().int().nonnegative(),
    clientId: nonEmptyStringSchema,
    consumerGroupId: nonEmptyStringSchema,
  }),
  asyncTask: z.object({
    defaultMaxAttempts: z.number().int().positive(),
    retryBaseMs: z.number().int().positive(),
    retryMaxMs: z.number().int().positive(),
    idempotencyTtlHours: z.number().int().positive(),
  }),
});

export const asyncRuntimeOutboxTopicCountsSchema = z.object({
  topic: nonEmptyStringSchema,
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  oldestPendingAgeMs: z.number().int().nonnegative(),
});

export const asyncRuntimeTaskCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const asyncRuntimeHealthSchema = z.object({
  service: z.literal("async-runtime"),
  status: z.enum(["ok", "degraded", "blocked"]),
  mode: z.literal("async_runtime_health"),
  runtimePlan: asyncRuntimePlanSchema,
  outboxByTopic: z.array(asyncRuntimeOutboxTopicCountsSchema),
  tasks: asyncRuntimeTaskCountsSchema,
  alerts: z.array(asyncRuntimeHealthAlertSchema),
  blockedReasons: z.array(nonEmptyStringSchema),
  checkedAt: isoDateTimeSchema,
});

export type AdminSummary = z.infer<typeof adminSummarySchema>;

export type AsyncRuntimeHealthAlert = z.infer<typeof asyncRuntimeHealthAlertSchema>;

export type AsyncRuntimePlan = z.infer<typeof asyncRuntimePlanSchema>;

export type AsyncRuntimeOutboxTopicCounts = z.infer<typeof asyncRuntimeOutboxTopicCountsSchema>;

export type AsyncRuntimeTaskCounts = z.infer<typeof asyncRuntimeTaskCountsSchema>;

export type AsyncRuntimeHealth = z.infer<typeof asyncRuntimeHealthSchema>;
