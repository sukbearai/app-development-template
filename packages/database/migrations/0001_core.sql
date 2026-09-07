create table app_users (
  id text primary key,
  account text not null unique,
  display_name text not null,
  password_hash text not null,
  status text not null default 'enabled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table app_roles (
  id text primary key,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table app_permissions (
  id text primary key,
  name text not null
);

create table app_user_roles (
  user_id text not null references app_users(id),
  role_id text not null references app_roles(id),
  primary key (user_id, role_id)
);

create table app_role_permissions (
  role_id text not null references app_roles(id),
  permission_id text not null references app_permissions(id),
  primary key (role_id, permission_id)
);

create table app_user_sessions (
  id text primary key,
  user_id text not null references app_users(id),
  secret_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table app_audit_logs (
  id text primary key,
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  trace_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table app_telemetry_events (
  id text primary key,
  event text not null,
  route text,
  trace_id text not null,
  payload jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create table app_file_assets (
  id text primary key,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  storage_key text not null,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);

create table app_outbox_events (
  id text primary key,
  topic text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  trace_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index app_user_sessions_user_idx on app_user_sessions(user_id);
create index app_audit_logs_trace_idx on app_audit_logs(trace_id);
create index app_telemetry_events_trace_idx on app_telemetry_events(trace_id);
create index app_outbox_events_status_next_idx on app_outbox_events(status, next_attempt_at);

insert into app_permissions(id, name) values
  ('system.read', '查看系统状态'),
  ('admin.read', '查看后台'),
  ('admin.write', '管理后台数据'),
  ('file.upload', '上传文件')
on conflict (id) do update set name = excluded.name;

insert into app_roles(id, name, status) values
  ('role_admin', '管理员', 'active')
on conflict (id) do update set name = excluded.name, status = excluded.status;

insert into app_role_permissions(role_id, permission_id)
select 'role_admin', id from app_permissions
on conflict do nothing;

insert into app_users(id, account, display_name, password_hash, status) values
  ('user_admin', 'admin', '管理员', 'plain:admin', 'enabled')
on conflict (id) do update set
  account = excluded.account,
  display_name = excluded.display_name,
  status = excluded.status;

insert into app_user_roles(user_id, role_id) values
  ('user_admin', 'role_admin')
on conflict do nothing;
