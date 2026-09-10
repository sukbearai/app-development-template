import { z } from "zod";

import {
  nonEmptyStringSchema,
  optionalNonEmptyStringSchema,
  isoDateTimeSchema,
  jsonRecordSchema,
  pageQueryFields,
  searchTextSchema,
  pageInfoSchema,
} from "../../primitives.ts";

export const auditEventSchema = z.object({
  id: nonEmptyStringSchema,
  actorId: optionalNonEmptyStringSchema,
  action: nonEmptyStringSchema,
  targetType: optionalNonEmptyStringSchema,
  targetId: optionalNonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  createdAt: isoDateTimeSchema,
  metadata: jsonRecordSchema.optional(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageQuerySchema = z.object({
  ...pageQueryFields,
  action: searchTextSchema,
  sort: z.enum(["createdAt", "action"]).default("createdAt"),
});

export const auditPageSchema = pageInfoSchema.extend({ items: z.array(auditEventSchema) });

export type AuditPageQuery = z.infer<typeof auditPageQuerySchema>;

export type AuditPage = z.infer<typeof auditPageSchema>;
