/** Direct canonical upgrades must retain the same incident boundary as emitted SQL. */
export const migration0028IncidentStabilityHardening = {
  version: 28,
  name: "incident_stability_hardening",
  sql: `
create index if not exists machine_runbook_schedules_scope
  on platform.machine_runbook_schedules(workspace_id, created_at desc);

alter table platform.incident_signal_state enable row level security;
alter table platform.incident_remediation_attempts enable row level security;
alter table platform.incident_maintenance_windows enable row level security;
alter table platform.incident_postmortems enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems from service_role;
    grant select,insert,update,delete on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems to service_role;
  end if;
end
$$;
`,
} as const;
