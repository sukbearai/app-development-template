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
CREATE UNIQUE INDEX "app_message_quarantine_source_idx" ON "app_message_quarantine" USING btree ("consumer_group","topic","partition","source_offset");
--> statement-breakpoint
ALTER TABLE app_outbox_events ADD COLUMN lease_generation integer NOT NULL DEFAULT 0, ADD COLUMN lease_until timestamptz;
--> statement-breakpoint
ALTER TABLE app_idempotency_keys ADD COLUMN lease_generation integer NOT NULL DEFAULT 0, ADD COLUMN locked_by text, ADD COLUMN lease_until timestamptz;
--> statement-breakpoint
ALTER TABLE app_users ADD CONSTRAINT app_users_status_check CHECK (status IN ('enabled','disabled'));
--> statement-breakpoint
ALTER TABLE app_roles ADD CONSTRAINT app_roles_status_check CHECK (status IN ('active','inactive'));
--> statement-breakpoint
UPDATE app_user_sessions SET revoked_at = now() WHERE user_id IN (SELECT id FROM app_users WHERE password_hash LIKE 'plain:%' OR status = 'disabled');
--> statement-breakpoint
UPDATE app_users SET status = 'disabled', updated_at = now() WHERE password_hash LIKE 'plain:%';
