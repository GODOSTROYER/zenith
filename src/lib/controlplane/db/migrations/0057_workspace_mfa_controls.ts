/** UX-01: workspace-owned MFA controls. Expand-only; no Auth factors or secrets. */
export const migration0057WorkspaceMfaControls = {
  version: 57,
  name: "workspace_mfa_controls",
  sql: `
create table if not exists platform.workspace_mfa_controls (
  workspace_id text primary key,
  require_for_all_mutations boolean not null default false,
  max_age_seconds integer check (max_age_seconds between 60 and 86400),
  version integer not null default 1 check (version >= 1),
  updated_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table platform.workspace_mfa_controls enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.workspace_mfa_controls from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.workspace_mfa_controls from service_role;
    grant select,insert,update on table platform.workspace_mfa_controls to service_role;
  end if;
end
$$;
`,
} as const;
