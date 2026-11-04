/**
 * Last-run and health record for the critical periodic jobs (PROD-OBS-04).
 *
 * One row per job. System-level, not tenant data: the jobs sweep every workspace under
 * their own leases, so the row carries only counts and a fixed status vocabulary, never
 * workspace identifiers, errors or provider output. `last_fence` is the lease fence that
 * began the latest run; a stale holder (lease lost and taken over) cannot finish it.
 */
export const migration0021ScheduledJobRuns = {
  version: 21,
  name: "scheduled_job_runs",
  sql: `
create table if not exists platform.scheduled_job_runs (
  job                  text primary key check (job ~ '^[a-z][a-z0-9-]{0,63}$'),
  cadence_ms           integer not null check (cadence_ms between 1000 and 86400000),
  last_source          text not null check (last_source in ('temporal','fallback')),
  last_status          text not null check (last_status in ('running','ok','failed','skipped')),
  last_started_at      timestamptz not null default clock_timestamp(),
  last_finished_at     timestamptz,
  last_success_at      timestamptz,
  last_success_source  text check (last_success_source in ('temporal','fallback')),
  last_error_code      text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,64}$'),
  last_fence           bigint not null default 0,
  last_counts          jsonb not null default '{}'::jsonb,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  runs_total           bigint not null default 0,
  missed_ticks_total   bigint not null default 0,
  skipped_total        bigint not null default 0,
  updated_at           timestamptz not null default clock_timestamp()
);
alter table platform.scheduled_job_runs enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.scheduled_job_runs from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.scheduled_job_runs from service_role;
    grant select,insert,update on table platform.scheduled_job_runs to service_role;
  end if;
end
$$;
`,
} as const;
