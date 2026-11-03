/** Per-repository authority. Existing source digests retain repository ID + binding version. */
export const migration0060GithubRepositoryGrants = {
  version: 60,
  name: "github_repository_grants",
  sql: `
-- Generated Supabase snapshots replay earlier DDL. History adoption is one-time:
-- a grant created after this migration must never adopt a replaced repo's events.
do $github_repository_grants$
begin
if not exists(select 1 from platform.schema_migrations where version=60) then
alter table platform.github_source_bindings add column if not exists binding_id text not null default gen_random_uuid()::text;
create unique index if not exists github_bindings_tenant_id on platform.github_source_bindings(workspace_id,binding_id);
alter table platform.github_binding_events drop constraint if exists github_binding_events_workspace_id_fkey;
alter table platform.github_source_bindings drop constraint if exists github_source_bindings_pkey;
alter table platform.github_source_bindings add primary key(workspace_id,repository_id);
create unique index if not exists github_bindings_tenant_name on platform.github_source_bindings(workspace_id,owner,repo);
alter table platform.github_binding_events add column if not exists event_id text not null default gen_random_uuid()::text;
alter table platform.github_binding_events add column if not exists binding_id text;
-- Old replacements retain their own repository/install IDs. Only attach matching history;
-- never relabel a replaced repository as the workspace's latest source.
update platform.github_binding_events e set binding_id=b.binding_id
from platform.github_source_bindings b where e.workspace_id=b.workspace_id and e.repository_id=b.repository_id;
alter table platform.github_binding_events drop constraint if exists github_binding_events_pkey;
alter table platform.github_binding_events add primary key(workspace_id,event_id);
create unique index if not exists github_events_binding_version on platform.github_binding_events(workspace_id,binding_id,version) where binding_id is not null;
alter table platform.github_binding_events add foreign key(workspace_id,binding_id) references platform.github_source_bindings(workspace_id,binding_id);
end if;
end $github_repository_grants$;
alter table platform.github_install_intents add column if not exists purpose text not null default 'bind' check(purpose in ('bind','discover'));
alter table platform.github_install_intents add column if not exists return_to text check(return_to in ('/platform/source','/platform/coding-agent'));
alter table platform.github_install_intents add column if not exists expected_repository_id bigint check(expected_repository_id>0);
create table if not exists platform.github_discovery_sessions (
  workspace_id text not null,
  session_digest text not null check(session_digest ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  app_id text not null,
  installation_id bigint not null check(installation_id>0),
  installation_generation bigint not null check(installation_generation>=0),
  repositories jsonb not null check(jsonb_typeof(repositories)='array' and octet_length(repositories::text)<=2097152),
  truncated boolean not null default false,
  expires_at timestamptz not null,
  primary key(workspace_id,session_digest)
);
create index if not exists github_discovery_expiry on platform.github_discovery_sessions(expires_at);
create table if not exists platform.github_project_sources (
  workspace_id text not null,
  project_id text not null,
  binding_id text not null,
  ref text not null,
  root text not null default '',
  context_dir text not null default '',
  detached_at timestamptz,
  version integer not null default 1 check(version>0),
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,project_id),
  foreign key(workspace_id,binding_id) references platform.github_source_bindings(workspace_id,binding_id)
);
alter table platform.github_discovery_sessions enable row level security;
alter table platform.github_project_sources enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.github_discovery_sessions, platform.github_project_sources from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.github_source_bindings,platform.github_binding_events,platform.github_discovery_sessions,platform.github_project_sources from service_role;
    grant select,insert,update on table platform.github_source_bindings,platform.github_project_sources to service_role;
    grant select,insert on table platform.github_binding_events to service_role;
    grant select,insert,update,delete on table platform.github_discovery_sessions to service_role;
  end if;
end $$;
`,
} as const;
