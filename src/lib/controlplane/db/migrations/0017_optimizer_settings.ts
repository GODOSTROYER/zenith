/** Per-environment opt-in for scheduled economic optimization (PROD-COST-03). Default is off: no row means disabled. */
export const migration0017OptimizerSettings = {
  version: 17,
  name: "optimizer_settings",
  sql: `
create table if not exists platform.optimizer_settings (
  environment_id text primary key,
  workspace_id   text not null,
  enabled        boolean not null default false,
  version        integer not null default 1 check (version >= 1),
  updated_by     text not null,
  updated_at     timestamptz not null default clock_timestamp()
);
create index if not exists optimizer_settings_enabled on platform.optimizer_settings(workspace_id, environment_id) where enabled;
alter table platform.optimizer_settings enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.optimizer_settings from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.optimizer_settings from service_role;
    grant select,insert,update on table platform.optimizer_settings to service_role;
  end if;
end
$$;
`,
} as const;
