/** Authenticated standalone builtin completions. No cloud or credential history is cleared. */
export const migration0016CleanupWriterSettlements = {
  version: 16,
  name: "cleanup_writer_settlements",
  sql: `
create table if not exists platform.standalone_plan_backends (
  target_digest text primary key check (target_digest ~ '^[a-f0-9]{64}$'),
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists standalone_plan_backends_scope on platform.standalone_plan_backends(workspace_id,project_id,environment_id);
create table if not exists platform.standalone_plan_settlements (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  raw_sha256 text not null check (raw_sha256 ~ '^[a-f0-9]{64}$'),
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  target_digest text not null check (target_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  settlement_digest text not null check (settlement_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv)=16),
  auth_tag text not null check (length(auth_tag)=24),
  ciphertext text not null check (length(ciphertext) between 1 and 16384),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id),
  foreign key(target_digest) references platform.standalone_plan_backends(target_digest)
);
create index if not exists standalone_plan_settlements_scope on platform.standalone_plan_settlements(workspace_id,project_id,environment_id);
drop trigger if exists immutable_standalone_plan_backend on platform.standalone_plan_backends;
create trigger immutable_standalone_plan_backend before update or delete on platform.standalone_plan_backends
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_standalone_plan_settlement on platform.standalone_plan_settlements;
create trigger immutable_standalone_plan_settlement before update or delete on platform.standalone_plan_settlements
for each row execute function platform.immutable_cleanup_writer_history();
alter table platform.standalone_plan_backends enable row level security;
alter table platform.standalone_plan_settlements enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
    grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
  end if;
end
$$;
`,
} as const;
