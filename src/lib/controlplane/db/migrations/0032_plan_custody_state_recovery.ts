/**
 * PROD-DUR-05/06. Worker-bound custody grants and read receipts for encrypted plan artifacts,
 * immutable state-backend capability probes, and human-approved state restores.
 * Nothing here stores plan bytes, plaintext or cloud credentials. No row is ever deleted by code:
 * grants are revoked, restores move through a guarded state machine.
 */
export const migration0032PlanCustodyStateRecovery = {
  version: 32,
  name: "plan_custody_state_recovery",
  sql: `
create table if not exists platform.plan_custody_grants (
  workspace_id text not null,
  operation_id text not null,
  worker_identity text not null check (worker_identity ~ '^[A-Za-z0-9._-]{1,64}$'),
  fence_token bigint not null,
  source_operation_id text not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  token_digest text not null check (token_digest ~ '^[a-f0-9]{64}$'),
  wrap_iv text not null check (length(wrap_iv) = 16),
  wrap_tag text not null check (length(wrap_tag) = 24),
  wrap_ciphertext text not null check (length(wrap_ciphertext) between 1 and 256),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, worker_identity, fence_token),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists plan_custody_grants_worker on platform.plan_custody_grants (workspace_id, worker_identity);
create table if not exists platform.plan_custody_reads (
  id text primary key,
  workspace_id text not null,
  operation_id text not null,
  worker_identity text not null check (worker_identity ~ '^[A-Za-z0-9._-]{1,64}$'),
  manifest_digest text,
  outcome text not null check (outcome in ('allowed', 'refused')),
  reason text not null check (reason ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists plan_custody_reads_op on platform.plan_custody_reads (workspace_id, operation_id, created_at);
create table if not exists platform.state_backend_probes (
  id text primary key,
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  backend_kind text not null check (backend_kind in ('local', 'http', 's3', 'gcs', 'azurerm', 'pg')),
  verdict jsonb not null check (jsonb_typeof(verdict) = 'object' and pg_column_size(verdict) <= 16384),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists state_backend_probes_env on platform.state_backend_probes (workspace_id, environment_id, created_at desc);
create table if not exists platform.state_backend_restores (
  id text primary key,
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  backend jsonb not null check (jsonb_typeof(backend) = 'object' and pg_column_size(backend) <= 4096),
  state_key text not null check (length(state_key) between 1 and 1024),
  source_version_id text not null check (length(source_version_id) between 1 and 1024),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  current_version_id text not null check (length(current_version_id) between 1 and 1024),
  connection_id text not null check (length(connection_id) between 1 and 200),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executing', 'restored', 'failed_uncertain', 'expired')),
  requested_by jsonb not null,
  approved_by text,
  approved_at timestamptz,
  expires_at timestamptz not null,
  restored_version_id text,
  readback_sha256 text check (readback_sha256 is null or readback_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id)
);
create index if not exists state_backend_restores_env on platform.state_backend_restores (workspace_id, environment_id, created_at desc);
create or replace function platform.state_backend_restore_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'State backend restore records are never deleted' using errcode = '23514';
  end if;
  if new.workspace_id <> old.workspace_id or new.environment_id <> old.environment_id or new.proposal_digest <> old.proposal_digest
    or new.backend_digest <> old.backend_digest or new.state_key <> old.state_key or new.source_version_id <> old.source_version_id
    or new.source_sha256 <> old.source_sha256 or new.current_version_id <> old.current_version_id or new.connection_id <> old.connection_id
    or new.backend::text <> old.backend::text or new.requested_by::text <> old.requested_by::text or new.expires_at <> old.expires_at then
    raise exception 'A reviewed state restore proposal is immutable' using errcode = '23514';
  end if;
  if not ((old.status = 'proposed' and new.status in ('proposed', 'approved', 'rejected', 'expired'))
    or (old.status = 'approved' and new.status in ('approved', 'executing', 'expired'))
    or (old.status = 'executing' and new.status in ('executing', 'restored', 'failed_uncertain'))
    or old.status = new.status) then
    raise exception 'Invalid state restore transition' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
drop trigger if exists state_backend_restore_guard on platform.state_backend_restores;
create trigger state_backend_restore_guard before update or delete on platform.state_backend_restores
for each row execute function platform.state_backend_restore_guard();
drop trigger if exists immutable_plan_custody_read on platform.plan_custody_reads;
create trigger immutable_plan_custody_read before update or delete on platform.plan_custody_reads
for each row execute function platform.immutable_plan_artifact();
drop trigger if exists immutable_state_backend_probe on platform.state_backend_probes;
create trigger immutable_state_backend_probe before update or delete on platform.state_backend_probes
for each row execute function platform.immutable_plan_artifact();
alter table platform.plan_custody_grants enable row level security;
alter table platform.plan_custody_reads enable row level security;
alter table platform.state_backend_probes enable row level security;
alter table platform.state_backend_restores enable row level security;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.plan_custody_grants, platform.plan_custody_reads, platform.state_backend_probes, platform.state_backend_restores from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on table platform.plan_custody_grants, platform.plan_custody_reads, platform.state_backend_probes, platform.state_backend_restores to service_role;
  end if;
end
$$;
`,
} as const;
