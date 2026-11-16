/** Shared hand-off serialization and permanent possible-delivery history. No provider settlement is inferred. */
export const migration0015CleanupWriterBarriers = {
  version: 15,
  name: "cleanup_writer_barriers",
  sql: `
create table if not exists platform.cleanup_writer_epoch (
  singleton boolean primary key default true check (singleton),
  installed_at timestamptz not null default clock_timestamp()
);
insert into platform.cleanup_writer_epoch(singleton) values(true) on conflict do nothing;
-- Every scoped and unscoped writer takes this coordinator AFTER its existing row locks.
-- The exact environment holds are separate; unrelated scoped environments remain writable.
create table if not exists platform.cleanup_writer_scopes (
  workspace_id text primary key,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.cleanup_writer_holds (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null check (generation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  authority_digest text not null check (authority_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,project_id,environment_id),
  unique(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id)
);
create table if not exists platform.cleanup_writer_deliveries (
  workspace_id text not null,
  project_id text,
  environment_id text,
  operation_id text not null,
  family text not null check (family in ('workflow','plan','build','runner','machine','grant')),
  identity text not null,
  capability text not null,
  attempt_id text,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,family,identity)
);
create table if not exists platform.cleanup_owner_grants (
  workspace_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null,
  jti text not null unique,
  capability text not null check (capability='infrastructure.destroy'),
  audience text not null check (audience='worker'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id,attempt_id,generation)
    references platform.cleanup_writer_holds(workspace_id,operation_id,attempt_id,generation)
);
create or replace function platform.immutable_cleanup_writer_history() returns trigger language plpgsql as $$
begin
  raise exception 'Cleanup history cannot be changed or cleared' using errcode='23514';
end
$$;
drop trigger if exists immutable_cleanup_epoch on platform.cleanup_writer_epoch;
create trigger immutable_cleanup_epoch before update or delete on platform.cleanup_writer_epoch
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_scope on platform.cleanup_writer_scopes;
create trigger immutable_cleanup_scope before update or delete on platform.cleanup_writer_scopes
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_hold on platform.cleanup_writer_holds;
create trigger immutable_cleanup_hold before update or delete on platform.cleanup_writer_holds
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_delivery on platform.cleanup_writer_deliveries;
create trigger immutable_cleanup_delivery before update or delete on platform.cleanup_writer_deliveries
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_owner_grant on platform.cleanup_owner_grants;
create trigger immutable_cleanup_owner_grant before update or delete on platform.cleanup_owner_grants
for each row execute function platform.immutable_cleanup_writer_history();

create or replace function platform.cleanup_scope_epoch_unknown(ws text,proj text,env text) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,platform as $$
begin
  if to_regclass('public.environments') is null then return true; end if;
  return not exists(select 1 from public.environments e where e.workspace_id=ws and e.project_id=proj and e.id=env
    and e.created_at is not null and e.created_at >= (select installed_at from platform.cleanup_writer_epoch where singleton));
end
$$;
revoke all on function platform.cleanup_scope_epoch_unknown(text,text,text) from public;

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  select * into h from platform.cleanup_writer_holds where workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (project_id=o.project_id and environment_id=o.environment_id)) limit 1;
  if found then
    if family_name='grant' and delivery_cap='infrastructure.destroy' and new.audience='worker'
      and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
        on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
        where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
          and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
      and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
      and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
      and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
        and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
      delivery_attempt:=h.attempt_id;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;
drop trigger if exists cleanup_workflow_writer on platform.workflow_start_intents;
create trigger cleanup_workflow_writer before insert or update of phase on platform.workflow_start_intents
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_plan_writer on platform.plan_artifact_uses;
create trigger cleanup_plan_writer before insert or update of phase on platform.plan_artifact_uses
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_build_writer on platform.build_launches;
create trigger cleanup_build_writer before insert on platform.build_launches
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_runner_writer on platform.runner_jobs;
create trigger cleanup_runner_writer before insert or update of status on platform.runner_jobs
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_machine_writer on platform.machine_requests;
create trigger cleanup_machine_writer before insert or update of status on platform.machine_requests
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_grant_writer on platform.capability_grants;
create trigger cleanup_grant_writer before insert on platform.capability_grants
for each row execute function platform.cleanup_writer_transition();
revoke all on function platform.cleanup_writer_transition() from public;
revoke all on function platform.immutable_cleanup_writer_history() from public;
alter table platform.cleanup_writer_epoch enable row level security;
alter table platform.cleanup_writer_scopes enable row level security;
alter table platform.cleanup_writer_holds enable row level security;
alter table platform.cleanup_writer_deliveries enable row level security;
alter table platform.cleanup_owner_grants enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
    grant select on table platform.cleanup_writer_epoch to service_role;
    grant execute on function platform.cleanup_scope_epoch_unknown(text,text,text) to service_role;
    grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
    -- Row locking needs UPDATE privilege; the immutable trigger refuses actual UPDATE.
    grant update on table platform.cleanup_writer_scopes to service_role;
  end if;
end
$$;
`,
} as const;
