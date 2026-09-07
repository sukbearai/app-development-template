ALTER TABLE "app_upload_intents" DROP CONSTRAINT "app_upload_intents_state_check";--> statement-breakpoint
ALTER TABLE "app_upload_intents" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_upload_intents" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
CREATE INDEX "app_audit_logs_retention_idx" ON "app_audit_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "app_idempotency_keys_retention_idx" ON "app_idempotency_keys" USING btree ("created_at","key") WHERE "app_idempotency_keys"."response_data" is not null;--> statement-breakpoint
CREATE INDEX "app_idempotency_keys_recovery_idx" ON "app_idempotency_keys" USING btree ("lease_until","key") WHERE "app_idempotency_keys"."status" in ('pending','processing','failed');--> statement-breakpoint
CREATE INDEX "app_outbox_events_due_idx" ON "app_outbox_events" USING btree ("next_attempt_at","id") WHERE "app_outbox_events"."status" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "app_outbox_events_lease_idx" ON "app_outbox_events" USING btree ("lease_until","id") WHERE "app_outbox_events"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "app_outbox_events_retention_idx" ON "app_outbox_events" USING btree ("updated_at","id") WHERE "app_outbox_events"."status" = 'published';--> statement-breakpoint
CREATE INDEX "app_task_events_retention_idx" ON "app_task_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "app_telemetry_events_retention_idx" ON "app_telemetry_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "app_upload_intents_cleanup_idx" ON "app_upload_intents" USING btree ("updated_at","id") WHERE "app_upload_intents"."state" in ('pending','writing','cleanup');--> statement-breakpoint
ALTER TABLE "app_upload_intents" ADD CONSTRAINT "app_upload_intents_state_check" CHECK ("app_upload_intents"."state" in ('pending','writing','committed','cleanup','deleted','blocked'));