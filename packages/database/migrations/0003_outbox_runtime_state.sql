alter table app_outbox_events add column max_attempts integer not null default 5;
alter table app_outbox_events add column locked_by text;
alter table app_outbox_events add column locked_at timestamptz;
alter table app_outbox_events add column published_at timestamptz;
alter table app_outbox_events add column error_code text;
alter table app_outbox_events add column last_error text;

create index app_outbox_events_locked_idx on app_outbox_events(status, locked_at);
