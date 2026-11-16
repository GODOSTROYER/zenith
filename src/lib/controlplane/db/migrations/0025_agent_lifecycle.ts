/**
 * Agent delivery lifecycle (PROD-MACH-04): what a runner or zenithd machine last
 * reported about its connection, durable result spool and release state.
 *
 * Two additive columns on each agent table. `lifecycle` holds the validated,
 * bounded, non-secret report from the agent's last heartbeat; it is
 * informational and never an authority: staleness, revocation and dispatch
 * eligibility stay derived from `last_heartbeat_at` and `status`. No new table,
 * so tenancy and RLS conventions of `platform.runners` / `platform.machines`
 * apply unchanged.
 */
export const migration0025AgentLifecycle = {
  version: 25,
  name: "agent_lifecycle",
  sql: `
alter table platform.runners
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
alter table platform.machines
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runners_lifecycle_bounded') then
    alter table platform.runners add constraint runners_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'machines_lifecycle_bounded') then
    alter table platform.machines add constraint machines_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
end
$$;
`,
} as const;
