/** Revocation preserves binding versions so old callbacks cannot recreate authority. */
export const migration0009GithubRevocation = {
  version: 9,
  name: "github_revocation",
  sql: `
alter table platform.github_source_bindings add column if not exists revoked_at timestamptz;
alter table platform.github_source_bindings add column if not exists revoked_by text;
create table if not exists platform.github_binding_events (
  workspace_id text not null,
  version integer not null check (version > 0),
  action text not null check (action in ('bound', 'revoked')),
  actor_id text not null,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, version),
  foreign key (workspace_id) references platform.github_source_bindings (workspace_id)
);
-- This table records changes after this migration, never reconstructed history.
alter table platform.github_binding_events enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_binding_events from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table platform.github_binding_events to service_role;
  end if;
end
$$;
`,
} as const;
