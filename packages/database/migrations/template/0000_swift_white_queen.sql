CREATE TABLE "app_async_receipts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"consumer_group" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"trace_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_file_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"locked_by" text,
	"lease_until" timestamp with time zone,
	"request_hash" text NOT NULL,
	"response_data" jsonb,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_message_quarantine" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_group" text NOT NULL,
	"topic" text NOT NULL,
	"partition" integer NOT NULL,
	"source_offset" text NOT NULL,
	"raw_value" text,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"error_code" text,
	"last_error" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	CONSTRAINT "app_role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "app_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_roles_status_check" CHECK ("app_roles"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "app_task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"trace_id" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"error_code" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_telemetry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"route" text,
	"trace_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_upload_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"provider" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_upload_intents_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "app_upload_intents_state_check" CHECK ("app_upload_intents"."state" in ('pending','committed','cleanup','deleted'))
);
--> statement-breakpoint
CREATE TABLE "app_user_roles" (
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "app_user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "app_user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_account_unique" UNIQUE("account"),
	CONSTRAINT "app_users_status_check" CHECK ("app_users"."status" in ('enabled', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "app_role_permissions" ADD CONSTRAINT "app_role_permissions_role_id_app_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."app_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_role_permissions" ADD CONSTRAINT "app_role_permissions_permission_id_app_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."app_permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_role_id_app_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."app_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_sessions" ADD CONSTRAINT "app_user_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_audit_logs_trace_idx" ON "app_audit_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "app_idempotency_keys_scope_idx" ON "app_idempotency_keys" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "app_idempotency_keys_expires_at_idx" ON "app_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_message_quarantine_source_idx" ON "app_message_quarantine" USING btree ("consumer_group","topic","partition","source_offset");--> statement-breakpoint
CREATE INDEX "app_outbox_events_status_next_idx" ON "app_outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "app_outbox_events_locked_idx" ON "app_outbox_events" USING btree ("status","locked_at");--> statement-breakpoint
CREATE INDEX "app_task_events_task_created_at_idx" ON "app_task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "app_task_events_trace_idx" ON "app_task_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "app_tasks_status_idx" ON "app_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "app_tasks_trace_idx" ON "app_tasks" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "app_tasks_object_idx" ON "app_tasks" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "app_tasks_type_status_idx" ON "app_tasks" USING btree ("task_type","status");--> statement-breakpoint
CREATE INDEX "app_telemetry_events_trace_idx" ON "app_telemetry_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "app_user_sessions_user_idx" ON "app_user_sessions" USING btree ("user_id");