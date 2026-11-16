/** MACH-04: current human update/hold intent, scoped to one registered agent.
 * Identity/revocation is checked under the polymorphic agent's row lock by the
 * repository. No URLs, keys, signed tokens or artifact bytes are persisted here.
 * Expand-only: creates one new table with service-role-only access.
 */
export const migration0054AgentUpdateControls = {
  version: 54,
  name: "agent_update_controls",
  sql: `
create table if not exists platform.agent_update_controls (
  workspace_id text not null check (char_length(workspace_id) between 1 and 128),
  kind text not null check (kind in ('runner','machine')),
  agent_id text not null check (char_length(agent_id) between 1 and 128),
  revision integer not null check (revision > 0),
  hold boolean not null,
  manifest_sha256 text check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by text not null check (char_length(requested_by) between 1 and 128),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, kind, agent_id),
  check (not hold or manifest_sha256 is null)
);

alter table platform.agent_update_controls enable row level security;
revoke all on table platform.agent_update_controls from public;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.agent_update_controls from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on table platform.agent_update_controls to service_role;
  end if;
end
$$;
`,
} as const;
