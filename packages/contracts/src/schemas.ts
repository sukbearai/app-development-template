import { z } from "zod";

export const nonEmptyStringSchema = z.string().trim().min(1);
export const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();
export const jsonRecordSchema = z.record(z.string(), z.unknown());
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const userSchema = z.object({
  id: nonEmptyStringSchema,
  account: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  status: z.enum(["enabled", "disabled"]),
  roleIds: z.array(nonEmptyStringSchema),
  createdAt: isoDateTimeSchema,
});

export const roleSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  permissionIds: z.array(nonEmptyStringSchema),
  status: z.enum(["active", "inactive"]),
});

export const permissionSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});

export const authSessionSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
});

export const passwordSchema = z.string().min(1);
export const newPasswordSchema = passwordSchema.min(8).max(256);

export const changePasswordRequestSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: newPasswordSchema,
});
export const resetUserPasswordRequestSchema = z.object({ newPassword: newPasswordSchema });
export const changePasswordResponseSchema = z.object({ reauthenticate: z.literal(true) });
export const resetUserPasswordResponseSchema = z.object({ updated: z.literal(true) });

export const loginRequestSchema = z.object({
  account: nonEmptyStringSchema,
  password: passwordSchema,
});

export const loginResponseSchema = z.object({
  token: nonEmptyStringSchema,
  session: authSessionSchema,
  user: userSchema,
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
});

export const createUserRequestSchema = z.object({
  account: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  password: newPasswordSchema,
  roleIds: z.array(nonEmptyStringSchema).default([]),
  status: z.enum(["enabled", "disabled"]).default("enabled"),
});

export const updateUserRequestSchema = z.object({
  displayName: nonEmptyStringSchema.optional(),
  roleIds: z.array(nonEmptyStringSchema).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const createRoleRequestSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  permissionIds: z.array(nonEmptyStringSchema).default([]),
  status: z.enum(["active", "inactive"]).default("active"),
});

export const updateRoleRequestSchema = z.object({
  name: nonEmptyStringSchema.optional(),
  permissionIds: z.array(nonEmptyStringSchema).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const healthStatusSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: nonEmptyStringSchema,
  time: isoDateTimeSchema,
  dependencies: z.record(z.string(), z.string()),
  configIssues: z.array(nonEmptyStringSchema).optional(),
});

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

export const fileAssetSchema = z.object({
  id: nonEmptyStringSchema,
  fileName: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  storageKey: nonEmptyStringSchema,
  uploadedBy: optionalNonEmptyStringSchema,
  uploadedAt: isoDateTimeSchema,
});

export const filePageCursorSchema = z
  .object({
    uploadedAt: z.iso
      .datetime({ precision: 6 })
      .refine((value) => !value.startsWith("0000-"), "Invalid cursor year"),
    id: z
      .string()
      .min(1)
      .max(256)
      // oxlint-disable-next-line no-control-regex -- PostgreSQL text rejects NUL; lone surrogates also cannot round-trip.
      .regex(/^[^\u0000\uD800-\uDFFF]+$/u, "Invalid cursor identifier"),
  })
  .strict();

export const filePageQuerySchema = z.object({
  limit: z
    .union([z.string().regex(/^\d+$/), z.number()])
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .default(100),
  cursor: z
    .string()
    .max(1024)
    .transform((value, context) => {
      try {
        return JSON.parse(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid file page cursor" });
        return z.NEVER;
      }
    })
    .pipe(filePageCursorSchema)
    .optional(),
});

export const fileAssetPageSchema = z.object({
  items: z.array(fileAssetSchema),
  nextCursor: filePageCursorSchema.nullable(),
});
export type FilePageQuery = z.infer<typeof filePageQuerySchema>;
export type FileAssetPage = z.infer<typeof fileAssetPageSchema>;

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

export const adminSummarySchema = z.object({
  users: z.number().int().nonnegative(),
  auditEvents: z.number().int().nonnegative(),
  telemetryEvents: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  outboxPending: z.number().int().nonnegative(),
});

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

export interface ApiSuccess<T = unknown> {
  traceId: string;
  data: T;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Extension metadata has no domain fields; each operation validates its envelope.
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  traceId: string;
  error: {
    code: string;
    message: string;
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Failure diagnostics are an extensible JSON object in the HTTP contract.
    details?: Record<string, unknown>;
  };
}

export type User = z.infer<typeof userSchema>;
export type Role = z.infer<typeof roleSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type TelemetryRequest = z.input<typeof telemetryRequestSchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type FileAsset = z.infer<typeof fileAssetSchema>;
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
export type AdminSummary = z.infer<typeof adminSummarySchema>;
export type AsyncTaskStatus = z.infer<typeof asyncTaskStatusSchema>;
export type AsyncTaskKind = string;
export type KafkaConsumerOffset = z.infer<typeof kafkaConsumerOffsetSchema>;
export type AsyncTaskEventMessage<TPayload = unknown> = Omit<
  z.infer<typeof asyncTaskEventMessageSchema>,
  "payload"
> & {
  payload: TPayload;
};
export type AsyncRuntimeHealthAlert = z.infer<typeof asyncRuntimeHealthAlertSchema>;
export type AsyncRuntimePlan = z.infer<typeof asyncRuntimePlanSchema>;
export type AsyncRuntimeOutboxTopicCounts = z.infer<typeof asyncRuntimeOutboxTopicCountsSchema>;
export type AsyncRuntimeTaskCounts = z.infer<typeof asyncRuntimeTaskCountsSchema>;
export type AsyncRuntimeHealth = z.infer<typeof asyncRuntimeHealthSchema>;

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

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type ResetUserPasswordRequest = z.infer<typeof resetUserPasswordRequestSchema>;
