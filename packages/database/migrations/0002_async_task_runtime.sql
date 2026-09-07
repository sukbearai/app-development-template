create table app_idempotency_keys (
  key text primary key,
  scope text not null,
  request_hash text not null,
  response_data jsonb,
  status text not null default 'processing',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index app_idempotency_keys_scope_idx on app_idempotency_keys(scope);
create index app_idempotency_keys_expires_at_idx on app_idempotency_keys(expires_at);

create table app_tasks (
  id text primary key,
  task_type text not null,
  status text not null,
  progress integer not null default 0,
  trace_id text not null,
  object_type text,
  object_id text,
  error_code text,
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index app_tasks_status_idx on app_tasks(status);
create index app_tasks_trace_idx on app_tasks(trace_id);
create index app_tasks_object_idx on app_tasks(object_type, object_id);
create index app_tasks_type_status_idx on app_tasks(task_type, status);

create table app_task_events (
  id text primary key,
  task_id text not null,
  trace_id text not null,
  event_type text not null,
  status text,
  message text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index app_task_events_task_created_at_idx on app_task_events(task_id, created_at);
create index app_task_events_trace_idx on app_task_events(trace_id);
