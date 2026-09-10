import { z } from "zod";

import {
  nonEmptyStringSchema,
  optionalNonEmptyStringSchema,
  jsonRecordSchema,
  isoDateTimeSchema,
} from "../../primitives.ts";

export const telemetryRequestSchema = z.object({
  event: nonEmptyStringSchema,
  route: optionalNonEmptyStringSchema,
  payload: jsonRecordSchema.optional().default({}),
});

export const telemetryEventSchema = z.object({
  id: nonEmptyStringSchema,
  event: nonEmptyStringSchema,
  route: optionalNonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  occurredAt: isoDateTimeSchema,
  payload: jsonRecordSchema.optional(),
});

export type TelemetryRequest = z.input<typeof telemetryRequestSchema>;

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
