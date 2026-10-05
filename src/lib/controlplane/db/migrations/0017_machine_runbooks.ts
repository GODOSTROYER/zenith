/**
 * Signed runbooks, bounded schedules, runs, step custody and an append-only
 * audit chain (PROD-MACH-03). Versions, approvals and audit rows are immutable.
 * Credentials, command output and grants are never stored here.
 */
export const migration0017MachineRunbooks = {
  version: 17,
  name: "machine_runbooks",
  sql: `
create or replace function platform.immutable_runbook_rows() returns trigger language plpgsql as $$
begin
  raise exception 'Runbook versions, approvals and audit entries cannot be changed or removed' using errcode='23514';
end
$$;

create table if not exists platform.machine_runbook_versions (
  workspace_id text not null,
  runbook_id text not null check (runbook_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  version integer not null check (version >= 1),
  name text not null,
  definition jsonb not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  signature text not null check (length(signature) between 1 and 4096),
  signing_kid text not null,
  published_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, runbook_id, version)
);
drop trigger if exists immutable_runbook_versions on platform.machine_runbook_versions;
create trigger immutable_runbook_versions before update or delete on platform.machine_runbook_versions
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_approvals (
  id text primary key,
  workspace_id text not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  requested_by text not null,
  approver_id text not null check (approver_id <> requested_by),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists machine_runbook_approvals_binding on platform.machine_runbook_approvals(workspace_id, binding_digest, created_at desc);
drop trigger if exists immutable_runbook_approvals on platform.machine_runbook_approvals;
create trigger immutable_runbook_approvals before update or delete on platform.machine_runbook_approvals
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_schedules (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  spec jsonb not null,
  targets jsonb not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('pending_approval','active','paused','cancelled','completed')),
  next_due_at timestamptz,
  created_by text not null,
  creator jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version)
);
create index if not exists machine_runbook_schedules_due on platform.machine_runbook_schedules(next_due_at) where status = 'active';

create table if not exists platform.machine_runbook_runs (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  schedule_id text references platform.machine_runbook_schedules(id),
  due_at timestamptz,
  targets jsonb not null,
  max_parallel_targets integer not null check (max_parallel_targets between 1 and 5),
  status text not null check (status in ('pending_approval','approved','running','succeeded','failed','cancelled','expired','uncertain')),
  cancel_requested_at timestamptz,
  cancel_reason text,
  requested_by text not null,
  requester jsonb not null,
  deadline_at timestamptz not null,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version),
  check ((schedule_id is null) = (due_at is null))
);
create unique index if not exists machine_runbook_runs_slot on platform.machine_runbook_runs(schedule_id, due_at) where schedule_id is not null;
create index if not exists machine_runbook_runs_scope on platform.machine_runbook_runs(workspace_id, status, created_at desc);

create table if not exists platform.machine_runbook_run_steps (
  workspace_id text not null,
  run_id text not null references platform.machine_runbook_runs(id),
  target_index integer not null check (target_index >= 0),
  step_id text not null,
  operation_id text not null,
  status text not null check (status in ('started','succeeded','failed','uncertain','skipped')),
  error_code text,
  evidence_id text,
  started_at timestamptz not null,
  finished_at timestamptz,
  primary key (workspace_id, run_id, target_index, step_id)
);

create table if not exists platform.machine_runbook_audit (
  workspace_id text not null,
  subject text not null,
  seq integer not null check (seq >= 1),
  event text not null,
  actor text not null,
  detail jsonb not null,
  prev_digest text not null check (prev_digest ~ '^[a-f0-9]{64}$'),
  entry_digest text not null check (entry_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (workspace_id, subject, seq)
);
drop trigger if exists immutable_runbook_audit on platform.machine_runbook_audit;
create trigger immutable_runbook_audit before update or delete on platform.machine_runbook_audit
for each row execute function platform.immutable_runbook_rows();

alter table platform.machine_runbook_versions enable row level security;
alter table platform.machine_runbook_approvals enable row level security;
alter table platform.machine_runbook_schedules enable row level security;
alter table platform.machine_runbook_runs enable row level security;
alter table platform.machine_runbook_run_steps enable row level security;
alter table platform.machine_runbook_audit enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from service_role;
    grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
    grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
  end if;
end
$$;
`,
} as const;
