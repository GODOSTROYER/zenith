/**
 * Service and recovery objective measurements (PROD-OPS-01).
 *
 *  - `slo_samples`: additive good/total event counts per SLI per five-minute bucket. Every API process (and the worker sampler)
 *    adds the DELTA of its in-process counters since its last flush, so the table sums correctly across
 *    instances and restarts and an error budget can be computed over a 30-day window without a metrics backend.
 *    Counts only: no tenant, route, principal or payload.
 *  - `slo_measurements`: append-only record of measured recovery and capacity results (RPO and RTO from restore
 *    rehearsals, sustained capacity from the load test). Update and delete are refused by trigger. `details`
 *    holds fixed numeric/ISO-time fields chosen by the writer code, never provider output.
 *
 * Both are system-level (no workspace_id): objectives apply to the platform, not to a tenant. The service role is
 * the only grantee, like the other platform tables.
 */
export const migration0045SloMeasurements = {
  version: 45,
  name: "slo_measurements",
  sql: `
create table if not exists platform.slo_samples (
  sli          text        not null check (sli ~ '^[a-z][a-z0-9_]{0,63}$'),
  bucket_start timestamptz not null,
  good         bigint      not null default 0 check (good >= 0),
  total        bigint      not null default 0 check (total >= 0),
  updated_at   timestamptz not null default clock_timestamp(),
  primary key (sli, bucket_start),
  check (good <= total)
);

create table if not exists platform.slo_measurements (
  seq         bigint generated always as identity primary key,
  id          text        not null unique check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind        text        not null check (kind in ('rpo','rto','capacity')),
  source      text        not null check (source in ('restore-rehearsal','recovery-drill','capacity-test','manual')),
  value       double precision not null check (value >= 0),
  unit        text        not null check (unit in ('seconds','requests_per_second')),
  within_target boolean,
  target_version text     check (target_version is null or char_length(target_version) <= 64),
  recorded_by text        not null check (char_length(recorded_by) between 1 and 128),
  details     jsonb       not null default '{}'::jsonb check (octet_length(details::text) <= 4096),
  measured_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check ((kind in ('rpo','rto') and unit = 'seconds') or (kind = 'capacity' and unit = 'requests_per_second'))
);
create index if not exists slo_measurements_kind_seq on platform.slo_measurements (kind, seq desc);

create or replace function platform.slo_measurements_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'SLO measurements are append-only' using errcode = '23514';
end
$$;
drop trigger if exists slo_measurements_immutable on platform.slo_measurements;
create trigger slo_measurements_immutable before update or delete on platform.slo_measurements
for each row execute function platform.slo_measurements_immutable();

alter table platform.slo_samples enable row level security;
alter table platform.slo_measurements enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['slo_samples','slo_measurements'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on table platform.slo_samples to service_role;
    grant select,insert on table platform.slo_measurements to service_role;
    grant usage on all sequences in schema platform to service_role;
  end if;
end
$$;
`,
} as const;
