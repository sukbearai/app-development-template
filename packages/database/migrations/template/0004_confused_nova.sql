CREATE TABLE "app_async_recovery_quarantine" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"consumer_group" text NOT NULL,
	"original_record" jsonb NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
