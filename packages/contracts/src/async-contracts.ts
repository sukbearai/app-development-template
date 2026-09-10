import { z } from "zod";

import { nonEmptyStringSchema, isoDateTimeSchema } from "./primitives.ts";

export const asyncTaskStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead_letter",
  "canceled",
]);

const asyncIdentifierMaxBytes = 2000;

const utf8Encoder = new TextEncoder();

export const asyncIdentifierSchema = nonEmptyStringSchema
  .max(asyncIdentifierMaxBytes)
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= asyncIdentifierMaxBytes,
    "Async identifier must not exceed 2000 UTF-8 bytes",
  )
  .describe(
    "At most 2000 UTF-8 bytes after trimming. The serialized [consumerGroup, idempotencyKey] must also fit 2000 UTF-8 bytes.",
  );

export const asyncConsumerGroupSchema = z
  .string()
  .min(1)
  .max(256)
  // oxlint-disable-next-line no-control-regex -- PostgreSQL text rejects NUL; lone surrogates also cannot round-trip.
  .regex(/^[^\u0000\uD800-\uDFFF]+$/u, "Consumer group must contain valid PostgreSQL text")
  .refine((value) => value.trim().length > 0, "Consumer group is required")
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= 256,
    "Consumer group must not exceed 256 UTF-8 bytes",
  )
  .describe(
    "At most 256 UTF-8 bytes. Whitespace is preserved as part of the consumer group identity.",
  );

export const kafkaConsumerOffsetSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(249)
    .regex(/^[A-Za-z0-9._-]+$/)
    .refine((value) => value !== "." && value !== "..", "Invalid Kafka topic"),
  partition: z.number().int().nonnegative().max(2147483647),
  offset: z
    .string()
    .max(19)
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine(
      (value) => value.length < 19 || value <= "9223372036854775807",
      "Kafka offset must fit a signed 64-bit integer",
    ),
  consumerGroup: asyncConsumerGroupSchema,
});

export const asyncTaskEventMessageSchema = z.object({
  eventId: asyncIdentifierSchema,
  eventType: asyncIdentifierSchema,
  traceId: asyncIdentifierSchema,
  taskId: asyncIdentifierSchema.optional(),
  idempotencyKey: asyncIdentifierSchema.optional(),
  attemptCount: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  nextRetryAt: isoDateTimeSchema.optional(),
  occurredAt: isoDateTimeSchema.optional(),
  payload: z.unknown(),
});

export type AsyncTaskStatus = z.infer<typeof asyncTaskStatusSchema>;

export type AsyncTaskKind = string;

export type KafkaConsumerOffset = z.infer<typeof kafkaConsumerOffsetSchema>;

export type AsyncTaskEventMessage<TPayload = unknown> = Omit<
  z.infer<typeof asyncTaskEventMessageSchema>,
  "payload"
> & {
  payload: TPayload;
};

export interface AsyncTaskEnvelope<TPayload = unknown> {
  taskId: string;
  taskType: AsyncTaskKind;
  traceId: string;
  status: AsyncTaskStatus;
  payload: TPayload;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt?: string;
  sourceEventId: string;
  source: {
    eventId: string;
    eventType: string;
    occurredAt?: string;
    offset?: KafkaConsumerOffset;
  };
  createdAt: string;
  updatedAt: string;
  lockedBy?: string;
  lockedUntil?: string;
  errorCode?: string;
  errorMessage?: string;
}
