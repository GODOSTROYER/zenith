/** Permanent CodeBuild dispatch inventory. No expiry, replay, purge or cleanup authority. */
export const migration0008BuildLaunches = {
  version: 8,
  name: "build_launches",
  sql: `
create table if not exists platform.build_launches (
  workspace_id text not null,
  operation_id text not null,
  service_address text not null,
  environment_id text not null,
  attempt_id text not null,
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  fence_token bigint not null,
  phase text not null default 'dispatched' check (phase in ('dispatched','accepted','terminal')),
  build_id text,
  request_ids jsonb,
  terminal_status text check (terminal_status in ('SUCCEEDED','FAILED','FAULT','TIMED_OUT','STOPPED')),
  provider_finished_at timestamptz,
  terminal_request_id text,
  created_at timestamptz not null default clock_timestamp(),
  accepted_at timestamptz,
  observed_at timestamptz,
  primary key (workspace_id, operation_id, service_address),
  unique (workspace_id, build_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding ?& array['workspaceId','operationId','environmentId','serviceAddress']
    and binding->>'workspaceId' = workspace_id and binding->>'operationId' = operation_id
    and binding->>'environmentId' = environment_id and binding->>'serviceAddress' = service_address),
  check ((phase = 'dispatched' and build_id is null and request_ids is null and accepted_at is null)
    or (phase in ('accepted','terminal') and build_id is not null and accepted_at is not null and request_ids is not null
      and jsonb_typeof(request_ids) = 'array' and jsonb_array_length(request_ids) > 0)),
  check ((phase <> 'terminal' and terminal_status is null and provider_finished_at is null and terminal_request_id is null and observed_at is null)
    or (phase = 'terminal' and terminal_status is not null and provider_finished_at is not null and terminal_request_id is not null and observed_at is not null))
);
create or replace function platform.immutable_build_launch() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Build launch inventory cannot be deleted' using errcode = '23514';
  end if;
  if (to_jsonb(NEW) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    is distinct from (to_jsonb(OLD) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    or (OLD.phase = 'dispatched' and NEW.phase not in ('dispatched','accepted'))
    or (OLD.phase = 'accepted' and NEW.phase not in ('accepted','terminal'))
    or (OLD.phase = 'terminal' and to_jsonb(NEW) is distinct from to_jsonb(OLD))
    or (OLD.build_id is not null and (NEW.build_id is distinct from OLD.build_id
      or NEW.request_ids is distinct from OLD.request_ids or NEW.accepted_at is distinct from OLD.accepted_at)) then
    raise exception 'Build launch identity and receipts are immutable' using errcode = '23514';
  end if;
  return NEW;
end
$$;
drop trigger if exists immutable_build_launch on platform.build_launches;
create trigger immutable_build_launch before update or delete on platform.build_launches
for each row execute function platform.immutable_build_launch();
create index if not exists build_launches_environment on platform.build_launches (workspace_id, environment_id, phase);
alter table platform.build_launches enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.build_launches from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update on table platform.build_launches to service_role;
  end if;
end
$$;
`,
} as const;
