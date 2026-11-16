/** Permanent operation-start tombstones. No TTL, pruning, cascading deletion, or retry lease. */
export const migration0012WorkflowStartIntents = {
  version: 12,
  name: "workflow_start_intents",
  sql: `
create table if not exists platform.workflow_start_intents (
  workspace_id text not null,
  operation_id text not null,
  binding jsonb not null check (octet_length(binding::text) <= 16000),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  observed_start_at timestamptz,
  evidence_digest text check (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding->>'format' = 'zenith.workflow-start.v1'
    and binding->'arguments'->>'workspaceId' = workspace_id
    and binding->'arguments'->>'operationId' = operation_id),
  check ((phase = 'prepared' and attempt_id is null and attempted_at is null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'attempted' and attempt_id is not null and attempted_at is not null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'acknowledged' and attempt_id is not null and attempted_at is not null
      and run_id is not null and observed_start_at is not null and evidence_digest is not null and acknowledged_at is not null))
);
create unique index if not exists workflow_start_intents_temporal_identity on platform.workflow_start_intents
  ((binding->>'endpointDigest'), (binding->>'namespace'), (binding->>'workflowId'));
create or replace function platform.retain_workflow_start_intent() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Workflow start tombstones cannot be deleted' using errcode = '23514';
  end if;
  if (new.workspace_id, new.operation_id, new.binding, new.binding_digest, new.created_at)
    is distinct from (old.workspace_id, old.operation_id, old.binding, old.binding_digest, old.created_at)
    or (old.attempt_id is not null and (new.attempt_id, new.attempted_at) is distinct from (old.attempt_id, old.attempted_at))
    or (old.phase = 'acknowledged' and new is distinct from old)
    or not ((old.phase = 'prepared' and new.phase = 'attempted')
      or (old.phase = 'attempted' and new.phase = 'acknowledged') or new is not distinct from old) then
    raise exception 'Workflow start intent is immutable and cannot be replayed' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_workflow_start_intent on platform.workflow_start_intents;
create trigger retain_workflow_start_intent before update or delete on platform.workflow_start_intents
for each row execute function platform.retain_workflow_start_intent();
alter table platform.workflow_start_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.workflow_start_intents from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- Creator defaults may include TRUNCATE, which bypasses every row trigger.
    -- Remove the complete inherited table grant before admitting only phase DML.
    revoke all on table platform.workflow_start_intents from service_role;
    grant select, insert, update on table platform.workflow_start_intents to service_role;
  end if;
end
$$;
`,
} as const;
