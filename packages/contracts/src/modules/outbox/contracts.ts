import { z } from "zod";

import {
  nonEmptyStringSchema,
  jsonRecordSchema,
  isoDateTimeSchema,
  optionalNonEmptyStringSchema,
} from "../../primitives.ts";

export const outboxEventSchema = z.object({
  id: nonEmptyStringSchema,
  topic: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  payload: jsonRecordSchema,
  status: z.enum(["pending", "processing", "published", "failed", "dead_letter"]),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDateTimeSchema,
  lockedBy: optionalNonEmptyStringSchema,
  lockedAt: isoDateTimeSchema.optional(),
  publishedAt: isoDateTimeSchema.optional(),
  errorCode: optionalNonEmptyStringSchema,
  lastError: optionalNonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;
