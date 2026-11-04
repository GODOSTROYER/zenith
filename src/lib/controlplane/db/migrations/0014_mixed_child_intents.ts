/** Native mixed-child candidates and permanent outbox custody. This version admits no child Start. */
export const migration0014MixedChildIntents = {
  version: 14,
  name: "mixed_child_intents",
  sql: `
create table if not exists platform.mixed_child_custody (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  partition_id text not null check (partition_id ~ '^[a-f0-9]{64}$'),
  descriptor jsonb not null check (octet_length(descriptor::text) <= 131072),
  descriptor_digest text not null check (descriptor_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, child_operation_id),
  unique (workspace_id, parent_operation_id, child_operation_id, descriptor_digest),
  foreign key (workspace_id, parent_operation_id) references platform.operations(workspace_id,id),
  foreign key (workspace_id, child_operation_id) references platform.operations(workspace_id,id),
  check (parent_operation_id <> child_operation_id),
  check (coalesce((descriptor->>'format' = 'zenith.mixed-child-candidate.v1'
    and descriptor->>'workspaceId' = workspace_id
    and descriptor->'parent'->>'operationId' = parent_operation_id
    and descriptor->'child'->>'operationId' = child_operation_id
    and descriptor->>'partitionId' = partition_id
    and descriptor->'executionEnabled' = 'false'::jsonb
    and descriptor->>'parentEffectCoverage' = 'unsupported'
    and descriptor->>'compilerReferenceCoverage' = 'unavailable'
    and descriptor->'artifactBytesAuthenticated' = 'false'::jsonb
    and descriptor->>'connectionAuthorization' = 'not_minted'),false))
);
create table if not exists platform.mixed_child_intents (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  descriptor_digest text not null,
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  receipt jsonb check (octet_length(receipt::text) <= 16000),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id,child_operation_id),
  foreign key (workspace_id,parent_operation_id,child_operation_id,descriptor_digest)
    references platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,descriptor_digest),
  check (coalesce(((phase='prepared' and attempt_id is null and run_id is null and receipt is null and attempted_at is null and acknowledged_at is null)
    or (phase='attempted' and attempt_id is not null and attempted_at is not null and run_id is null and receipt is null and acknowledged_at is null)
    or (phase='acknowledged' and attempt_id is not null and attempted_at is not null and run_id is not null and receipt is not null and acknowledged_at is not null
      and receipt->>'format'='zenith.mixed-child-history.v1'
      and receipt->>'workspaceId'=workspace_id and receipt->>'parentOperationId'=parent_operation_id
      and receipt->>'childOperationId'=child_operation_id and receipt->>'descriptorDigest'=descriptor_digest
      and receipt->>'attemptId'=attempt_id and receipt->>'runId'=run_id)),false))
);
create or replace function platform.immutable_mixed_child_custody() returns trigger language plpgsql as $$
begin
  raise exception 'Mixed child custody is immutable' using errcode='23514';
end
$$;
drop trigger if exists immutable_mixed_child_custody on platform.mixed_child_custody;
create trigger immutable_mixed_child_custody before update or delete on platform.mixed_child_custody
for each row execute function platform.immutable_mixed_child_custody();
create or replace function platform.retain_mixed_child_intent() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Mixed child attempt tombstones cannot be deleted' using errcode='23514';
  end if;
  if (new.workspace_id,new.parent_operation_id,new.child_operation_id,new.descriptor_digest,new.created_at)
    is distinct from (old.workspace_id,old.parent_operation_id,old.child_operation_id,old.descriptor_digest,old.created_at)
    or (old.attempt_id is not null and (new.attempt_id,new.attempted_at) is distinct from (old.attempt_id,old.attempted_at))
    or (old.phase='acknowledged' and new is distinct from old)
    or not ((old.phase='attempted' and new.phase='acknowledged') or new is not distinct from old) then
    -- No supported parent effects/browser-review representation exists yet.
    -- Even direct service-role UPDATE cannot promote a prepared candidate.
    raise exception 'Mixed child start is unsupported or nonreplayable' using errcode='23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_mixed_child_intent on platform.mixed_child_intents;
create trigger retain_mixed_child_intent before update or delete on platform.mixed_child_intents
for each row execute function platform.retain_mixed_child_intent();
alter table platform.mixed_child_custody enable row level security;
alter table platform.mixed_child_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant usage on schema platform to service_role;
    revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from service_role;
    grant select,insert on table platform.mixed_child_custody to service_role;
    grant select,insert,update on table platform.mixed_child_intents to service_role;
  end if;
end
$$;
`,
} as const;
