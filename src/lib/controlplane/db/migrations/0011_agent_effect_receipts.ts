/** Permanent authenticated agent outcome evidence; no projection or grant reopening. */
import type { PlatformMigration } from "./index";

export const migration0011AgentEffectReceipts: PlatformMigration = {
  version: 11,
  name: "agent_effect_receipts",
  sql: `
create table if not exists platform.agent_effect_receipts (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  agent_kind text not null check (agent_kind in ('runner','machine')),
  agent_id text not null check (agent_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_id text not null check (job_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runner_job_id text,
  machine_request_id text,
  operation_id text check (operation_id is null or operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_kind text not null check (job_kind ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  capability text not null check (capability ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  envelope_digest text not null check (envelope_digest ~ '^[a-f0-9]{64}$'),
  agent_key_digest text not null check (agent_key_digest ~ '^[a-f0-9]{64}$'),
  logical_digest text not null check (logical_digest ~ '^[a-f0-9]{64}$'),
  projection_status text not null check (projection_status in ('claimed','running','cancelled','timed_out')),
  reported_status text not null check (reported_status in ('succeeded','failed','rejected','timed_out')),
  claimed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  sealed jsonb not null check (
    jsonb_typeof(sealed) = 'object' and sealed ?& array['v','alg','iv','ct','tag']
    and sealed - 'v' - 'alg' - 'iv' - 'ct' - 'tag' = '{}'::jsonb
    and sealed->'v' = '1'::jsonb and sealed->>'alg' = 'A256GCM'
    and jsonb_typeof(sealed->'alg') = 'string' and jsonb_typeof(sealed->'iv') = 'string'
    and jsonb_typeof(sealed->'tag') = 'string' and jsonb_typeof(sealed->'ct') = 'string'
    and sealed->>'iv' ~ '^[A-Za-z0-9_-]{16}$' and sealed->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    and sealed->>'ct' ~ '^[A-Za-z0-9_-]+$' and octet_length(sealed->>'ct') <= 22369626),
  primary key (workspace_id, agent_kind, job_id),
  check ((agent_kind = 'runner' and runner_job_id is not null and runner_job_id = job_id and machine_request_id is null)
      or (agent_kind = 'machine' and machine_request_id is not null and machine_request_id = job_id and runner_job_id is null)),
  foreign key (workspace_id, runner_job_id) references platform.runner_jobs (workspace_id, id),
  foreign key (workspace_id, machine_request_id) references platform.machine_requests (workspace_id, id)
);
create index if not exists agent_effect_receipts_ws_op on platform.agent_effect_receipts (workspace_id, operation_id);

create or replace function platform.agent_effect_receipt_immutable() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Agent effect receipts cannot be changed or removed';
end $$;
drop trigger if exists agent_effect_receipt_immutable on platform.agent_effect_receipts;
create trigger agent_effect_receipt_immutable before update or delete on platform.agent_effect_receipts
  for each row execute function platform.agent_effect_receipt_immutable();

-- Original signed assignment and the first durable claim remain immutable.
create or replace function platform.runner_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.runner_id,new.operation_id,new.kind,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.runner_id,old.operation_id,old.kind,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original runner assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists runner_assignment_immutable on platform.runner_jobs;
create trigger runner_assignment_immutable before update on platform.runner_jobs
  for each row execute function platform.runner_assignment_immutable();

create or replace function platform.machine_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.machine_id,new.operation_id,new.operation,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.machine_id,old.operation_id,old.operation,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original machine assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists machine_assignment_immutable on platform.machine_requests;
create trigger machine_assignment_immutable before update on platform.machine_requests
  for each row execute function platform.machine_assignment_immutable();

alter table platform.agent_effect_receipts enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.agent_effect_receipts from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The same creator can inherit older emitted default UPDATE/DELETE grants.
    revoke all on table platform.agent_effect_receipts from service_role;
    grant select, insert on table platform.agent_effect_receipts to service_role;
  end if;
end $$;
`,
};
