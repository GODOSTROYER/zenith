-- Native OAuth resource grants for the existing browser consent/journal contract.
-- No OAuth token, key, refresh token or arbitrary Grant document is stored.
-- Agent ledger version 3 is required only by OAuth methods; old journal work
-- remains compatible with versions 1 and 2. The historical ledger has no checksum.
-- Apply with the same operator authority as 0006/0007, never from application code.
begin;
set local search_path = pg_catalog;

create schema if not exists agent;
create table if not exists agent.schema_migrations (
  version integer not null primary key, name text not null, applied_at text not null
);

do $$
begin
  if exists (select 1 from agent.schema_migrations where version = 3 and name <> 'agent-oauth-grants-v1') then
    raise exception 'The OAuth grant migration ledger conflicts with this build.' using errcode = '23514';
  end if;
  if exists (select 1 from agent.schema_migrations where version = 3)
    and to_regclass('agent.agent_oauth_grants') is null then
    raise exception 'The recorded OAuth grant table is absent.' using errcode = '23514';
  end if;
  -- Refuse incompatible partial tables rather than quietly adopting their data.
  if to_regclass('agent.agent_oauth_grants') is not null and (
    select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text order by a.attnum)
    from pg_attribute a where a.attrelid = to_regclass('agent.agent_oauth_grants') and a.attnum > 0 and not a.attisdropped
  ) is distinct from array[
    'integration_id:text:true','subject:text:true','client_id:text:true','workspace_id:text:true',
    'oauth_issuer:text:true','expires_at:text:true','revoked:boolean:true','project_ids:jsonb:true',
    'environment_ids:jsonb:false','app_ids:jsonb:false','scopes:jsonb:true'
  ] then
    raise exception 'The OAuth grant table is incompatible with this build.' using errcode = '23514';
  end if;
end $$;

-- Bounded, non-authorizing CHECK helper; callers cannot use it to create a grant.
create or replace function agent.oauth_grant_ids_valid(value jsonb, minimum integer, maximum integer)
returns boolean language sql immutable strict set search_path = pg_catalog as $$
  select case when jsonb_typeof(value) = 'array' then
    jsonb_array_length(value) between minimum and maximum
    and not exists (select 1 from jsonb_array_elements(value) as items(element)
      where jsonb_typeof(element) <> 'string' or (element #>> '{}') !~ '^[A-Za-z0-9_-]{1,100}$')
    and (select count(distinct element) from jsonb_array_elements(value) as items(element)) = jsonb_array_length(value)
    else false end
$$;

create table if not exists agent.agent_oauth_grants (
  integration_id text not null primary key,
  subject text not null,
  client_id text not null,
  workspace_id text not null,
  oauth_issuer text not null,
  expires_at text not null,
  revoked boolean not null default false,
  project_ids jsonb not null,
  environment_ids jsonb,
  app_ids jsonb,
  scopes jsonb not null,
  constraint agent_oauth_grants_binding unique (subject, client_id, workspace_id),
  constraint agent_oauth_grants_integration check (integration_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  constraint agent_oauth_grants_subject check (subject ~ '^[A-Za-z0-9_-]{1,100}$'),
  constraint agent_oauth_grants_workspace check (workspace_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  constraint agent_oauth_grants_client check (length(client_id) between 1 and 200),
  constraint agent_oauth_grants_issuer check (length(oauth_issuer) between 1 and 2048 and oauth_issuer ~* '^https://'),
  constraint agent_oauth_grants_expiry check (expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  constraint agent_oauth_grants_projects check (agent.oauth_grant_ids_valid(project_ids, 1, 100)),
  constraint agent_oauth_grants_environments check (environment_ids is null or agent.oauth_grant_ids_valid(environment_ids, 0, 100)),
  constraint agent_oauth_grants_apps check (app_ids is null or agent.oauth_grant_ids_valid(app_ids, 0, 100)),
  constraint agent_oauth_grants_scopes check (agent.oauth_grant_ids_valid(scopes, 1, 6) and scopes ? 'read'
    and scopes <@ '["read","plan","export","write","publish","logs"]'::jsonb)
);

-- Each binding keeps its original integration identity, including after revoke/expiry.
create or replace function agent.guard_oauth_grant_identity()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if row(new.integration_id, new.subject, new.client_id, new.workspace_id)
    is distinct from row(old.integration_id, old.subject, old.client_id, old.workspace_id) then
    raise exception 'The OAuth resource grant binding is immutable.' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists agent_oauth_grants_identity on agent.agent_oauth_grants;
create trigger agent_oauth_grants_identity before update on agent.agent_oauth_grants
  for each row execute function agent.guard_oauth_grant_identity();

-- Compare native definitions, types, columns and enforcing indexes, not names alone.
-- These definitions are shared with the journal registry used by the CI verifier.
do $$
begin
  if exists (select 1 from pg_policy where polrelid = 'agent.agent_oauth_grants'::regclass) then
    raise exception 'The OAuth grant table has incompatible client policies.' using errcode = '23514';
  end if;
  if exists (
    with expected(name, kind, columns, definition) as (values
      ('agent_oauth_grants_apps','c','{10}',$definition$CHECK (((app_ids IS NULL) OR agent.oauth_grant_ids_valid(app_ids, 0, 100)))$definition$),
      ('agent_oauth_grants_binding','u','{2,3,4}',$definition$UNIQUE (subject, client_id, workspace_id)$definition$),
      ('agent_oauth_grants_client','c','{3}',$definition$CHECK (((length(client_id) >= 1) AND (length(client_id) <= 200)))$definition$),
      ('agent_oauth_grants_environments','c','{9}',$definition$CHECK (((environment_ids IS NULL) OR agent.oauth_grant_ids_valid(environment_ids, 0, 100)))$definition$),
      ('agent_oauth_grants_expiry','c','{6}',$definition$CHECK ((expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'::text))$definition$),
      ('agent_oauth_grants_integration','c','{1}',$definition$CHECK ((integration_id ~ '^[A-Za-z0-9_-]{1,100}$'::text))$definition$),
      ('agent_oauth_grants_issuer','c','{5}',$definition$CHECK ((((length(oauth_issuer) >= 1) AND (length(oauth_issuer) <= 2048)) AND (oauth_issuer ~* '^https://'::text)))$definition$),
      ('agent_oauth_grants_pkey','p','{1}',$definition$PRIMARY KEY (integration_id)$definition$),
      ('agent_oauth_grants_projects','c','{8}',$definition$CHECK (agent.oauth_grant_ids_valid(project_ids, 1, 100))$definition$),
      ('agent_oauth_grants_scopes','c','{11}',$definition$CHECK ((agent.oauth_grant_ids_valid(scopes, 1, 6) AND (scopes ? 'read'::text) AND (scopes <@ '["read", "plan", "export", "write", "publish", "logs"]'::jsonb)))$definition$),
      ('agent_oauth_grants_subject','c','{2}',$definition$CHECK ((subject ~ '^[A-Za-z0-9_-]{1,100}$'::text))$definition$),
      ('agent_oauth_grants_workspace','c','{4}',$definition$CHECK ((workspace_id ~ '^[A-Za-z0-9_-]{1,100}$'::text))$definition$)
    )
    select 1 from expected e full join (select * from pg_constraint
      where conrelid = 'agent.agent_oauth_grants'::regclass) c on c.conname = e.name
    where c.oid is null or e.name is null or c.contype::text <> e.kind or c.conkey::text <> e.columns
      or pg_get_constraintdef(c.oid, false) <> e.definition or not c.convalidated
      or c.condeferrable or c.condeferred or not c.conislocal or c.coninhcount <> 0
      or c.connoinherit is distinct from (c.contype in ('p','u')) or c.conparentid <> 0
      or (c.contype = 'c' and c.conindid <> 0)
      or (c.contype in ('p','u') and not exists (
        select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid
          join pg_am am on am.oid = ic.relam
        where i.indexrelid = c.conindid and i.indrelid = c.conrelid and ic.relname = c.conname
          and i.indisunique and i.indimmediate and i.indisvalid and i.indisready and i.indislive
          and i.indisprimary = (c.contype = 'p') and not i.indisexclusion
          and i.indnatts = cardinality(c.conkey) and i.indnkeyatts = cardinality(c.conkey)
          and i.indkey::text = array_to_string(c.conkey, ' ') and i.indexprs is null and i.indpred is null
          and am.amname = 'btree'
          and not exists (select 1 from unnest(i.indclass::oid[]) as classes(opclass)
            join pg_opclass op on op.oid = classes.opclass join pg_namespace ns on ns.oid = op.opcnamespace
            where op.opcname <> 'text_ops' or ns.nspname <> 'pg_catalog')
          and array(select unnest(i.indcollation::oid[])) = (select array_agg(a.attcollation order by keys.position)
            from unnest(c.conkey) with ordinality as keys(attnum,position)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = keys.attnum)
      ))
  ) then
    raise exception 'The OAuth grant constraints are incompatible with this build.' using errcode = '23514';
  end if;
end $$;

alter table agent.schema_migrations enable row level security;
alter table agent.agent_oauth_grants enable row level security;
-- No client policies are introduced; revoke even inherited table default grants.
revoke all on agent.agent_oauth_grants from public, anon, authenticated, service_role;
grant usage on schema agent to service_role;
grant select, insert, update on agent.agent_oauth_grants to service_role;
revoke all on function agent.oauth_grant_ids_valid(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function agent.guard_oauth_grant_identity() from public, anon, authenticated;
grant execute on function agent.oauth_grant_ids_valid(jsonb, integer, integer) to service_role;
grant execute on function agent.guard_oauth_grant_identity() to service_role;

insert into agent.schema_migrations (version, name, applied_at)
  values (3, 'agent-oauth-grants-v1', '2026-10-04T00:00:00.000Z') on conflict (version) do nothing;
commit;
