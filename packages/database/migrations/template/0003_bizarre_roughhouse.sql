CREATE TABLE "app_kafka_recovery" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"state" text NOT NULL,
	"logical_group" text NOT NULL,
	"transport_group" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_kafka_recovery_singleton_check" CHECK ("app_kafka_recovery"."singleton" = true),
	CONSTRAINT "app_kafka_recovery_state_check" CHECK ("app_kafka_recovery"."state" in ('restoring','ready'))
);
