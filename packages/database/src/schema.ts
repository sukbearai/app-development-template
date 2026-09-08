import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  bigint,
  index,
  check,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

export const appUsers = pgTable(
  "app_users",
  {
    id: text("id").primaryKey(),
    account: text("account").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status", { enum: ["enabled", "disabled"] })
      .notNull()
      .default("enabled"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "app_users_status_check",
      sql`${table.status} in ('enabled', 'disabled')`,
    ),
  ],
);

export const appRoles = pgTable(
  "app_roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "inactive"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "app_roles_status_check",
      sql`${table.status} in ('active', 'inactive')`,
    ),
  ],
);

export const appPermissions = pgTable("app_permissions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const appUserRoles = pgTable(
  "app_user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => appUsers.id),
    roleId: text("role_id")
      .notNull()
      .references(() => appRoles.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
  }),
);

export const appRolePermissions = pgTable(
  "app_role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => appRoles.id),
    permissionId: text("permission_id")
      .notNull()
      .references(() => appPermissions.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  }),
);

export const appUserSessions = pgTable(
  "app_user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => appUsers.id),
    secretHash: text("secret_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    userIdx: index("app_user_sessions_user_idx").on(table.userId),
    retentionIdx: index("app_user_sessions_retention_idx").on(sql`least(${table.expiresAt}, ${table.revokedAt})`, table.id),
  }),
);

export const appAuditLogs = pgTable(
  "app_audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    traceId: text("trace_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    retentionIdx: index("app_audit_logs_retention_idx").on(
      table.createdAt,
      table.id,
    ),
    traceIdx: index("app_audit_logs_trace_idx").on(table.traceId),
  }),
);

export const appTelemetryEvents = pgTable(
  "app_telemetry_events",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    route: text("route"),
    traceId: text("trace_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    retentionIdx: index("app_telemetry_events_retention_idx").on(
      table.occurredAt,
      table.id,
    ),
    traceIdx: index("app_telemetry_events_trace_idx").on(table.traceId),
  }),
);

export const appFileAssets = pgTable("app_file_assets", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(),
  uploadedBy: text("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [index("app_file_assets_page_idx").on(table.uploadedAt.desc(), table.id.desc())]);

export const appOutboxEvents = pgTable(
  "app_outbox_events",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    errorCode: text("error_code"),
    lastError: text("last_error"),
    traceId: text("trace_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dueIdx: index("app_outbox_events_due_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} in ('pending','failed')`),
    leaseIdx: index("app_outbox_events_lease_idx")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.status} = 'processing'`),
    retentionIdx: index("app_outbox_events_retention_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} = 'published'`),
    statusNextIdx: index("app_outbox_events_status_next_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    lockIdx: index("app_outbox_events_locked_idx").on(
      table.status,
      table.lockedAt,
    ),
  }),
);

export const appIdempotencyKeys = pgTable(
  "app_idempotency_keys",
  {
    key: text("key").primaryKey(),
    scope: text("scope").notNull(),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    lockedBy: text("locked_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    requestHash: text("request_hash").notNull(),
    responseData: jsonb("response_data"),
    status: text("status").notNull().default("processing"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    retentionIdx: index("app_idempotency_keys_retention_idx")
      .on(table.createdAt, table.key)
      .where(sql`${table.responseData} is not null`),
    recoveryIdx: index("app_idempotency_keys_recovery_idx")
      .on(table.leaseUntil, table.key)
      .where(sql`${table.status} in ('pending','processing','failed')`),
    scopeIdx: index("app_idempotency_keys_scope_idx").on(table.scope),
    expiresAtIdx: index("app_idempotency_keys_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export const appTasks = pgTable(
  "app_tasks",
  {
    id: text("id").primaryKey(),
    taskType: text("task_type").notNull(),
    status: text("status").notNull(),
    progress: integer("progress").notNull().default(0),
    traceId: text("trace_id").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    errorCode: text("error_code"),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index("app_tasks_status_idx").on(table.status),
    traceIdx: index("app_tasks_trace_idx").on(table.traceId),
    objectIdx: index("app_tasks_object_idx").on(
      table.objectType,
      table.objectId,
    ),
    typeStatusIdx: index("app_tasks_type_status_idx").on(
      table.taskType,
      table.status,
    ),
  }),
);

export const appTaskEvents = pgTable(
  "app_task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    traceId: text("trace_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status"),
    message: text("message"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    retentionIdx: index("app_task_events_retention_idx").on(
      table.createdAt,
      table.id,
    ),
    taskCreatedAtIdx: index("app_task_events_task_created_at_idx").on(
      table.taskId,
      table.createdAt,
    ),
    traceIdx: index("app_task_events_trace_idx").on(table.traceId),
  }),
);

export const appUploadIntents = pgTable(
  "app_upload_intents",
  {
    id: text("id").primaryKey(),
    storageKey: text("storage_key").notNull().unique(),
    provider: text("provider", { enum: ["local", "s3"] }).notNull(),
    storageLocation: text("storage_location")
      .notNull()
      .default("legacy-unbound"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    state: text("state", {
      enum: [
        "pending",
        "writing",
        "committed",
        "cleanup",
        "deleted",
        "blocked",
      ],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("app_upload_intents_cleanup_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.state} in ('pending','writing','cleanup')`),
    check(
      "app_upload_intents_state_check",
      sql`${table.state} in ('pending','writing','committed','cleanup','deleted','blocked')`,
    ),
  ],
);
export const appAsyncReceipts = pgTable("app_async_receipts", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  taskId: text("task_id").notNull(),
  consumerGroup: text("consumer_group").notNull(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const appAsyncRecoveryQuarantine = pgTable("app_async_recovery_quarantine", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  consumerGroup: text("consumer_group").notNull(),
  originalRecord: jsonb("original_record").notNull(),
  errorCode: text("error_code").notNull(),
  errorMessage: text("error_message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const appMessageQuarantine = pgTable(
  "app_message_quarantine",
  {
    id: text("id").primaryKey(),
    consumerGroup: text("consumer_group").notNull(),
    topic: text("topic").notNull(),
    partition: integer("partition").notNull(),
    sourceOffset: text("source_offset").notNull(),
    rawValue: text("raw_value"),
    errorCode: text("error_code").notNull(),
    errorMessage: text("error_message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("app_message_quarantine_source_idx").on(
      table.consumerGroup,
      table.topic,
      table.partition,
      table.sourceOffset,
    ),
  ],
);

export const appKafkaRecovery = pgTable(
  "app_kafka_recovery",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    state: text("state", { enum: ["restoring", "ready"] }).notNull(),
    logicalGroup: text("logical_group").notNull(),
    transportGroup: text("transport_group").notNull(),
    checkpoint: jsonb("checkpoint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("app_kafka_recovery_singleton_check", sql`${table.singleton} = true`),
    check("app_kafka_recovery_state_check", sql`${table.state} in ('restoring','ready')`),
  ],
);
