/**
 * Fair, bounded control plane (PROD-OPS-02).
 *
 *  - `ops_maintenance`: ONE row (`id = 'global'`), the operator-set maintenance mode.
 *    System-level, not tenant data: holds only a fixed mode word, a short reason and
 *    the acting operator's user id. Writers pass `expectedVersion`.
 *  - `ops_maintenance_history`: append-only audit of every change.
 *  - `tenant_quotas`: per-workspace overrides of the default rate, concurrency and
 *    queue limits plus the scheduling weight. Null = use the platform default.
 *    Tenant-owned (`workspace_id`); written only by a platform operator.
 *  - `runner_jobs_ws_queued`: the queued-jobs-per-workspace count that bounds the
 *    runner queue is an index scan, not a table scan.
 *
 * Idempotent DDL. Grants mirror the other platform tables: the service role only.
 */
export const migration0038FairBoundedControlPlane = {
  version: 38,
  name: "fair_bounded_control_plane",
  sql: `
create table if not exists platform.ops_maintenance (
  id         text primary key check (id = 'global'),
  mode       text not null check (mode in ('off','dispatch_paused','read_only')),
  reason     text not null default '' check (char_length(reason) <= 300),
  version    integer not null default 1 check (version >= 1),
  updated_by text not null check (char_length(updated_by) between 1 and 128),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists platform.ops_maintenance_history (
  seq     bigint generated always as identity primary key,
  mode    text not null check (mode in ('off','dispatch_paused','read_only')),
  reason  text not null check (char_length(reason) <= 300),
  version integer not null check (version >= 1),
  actor   text not null check (char_length(actor) between 1 and 128),
  at      timestamptz not null default clock_timestamp()
);

create or replace function platform.ops_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Maintenance history is append-only' using errcode = '23514';
end
$$;
drop trigger if exists ops_maintenance_history_immutable on platform.ops_maintenance_history;
create trigger ops_maintenance_history_immutable before update or delete on platform.ops_maintenance_history
for each row execute function platform.ops_history_immutable();

create table if not exists platform.tenant_quotas (
  workspace_id            text primary key check (char_length(workspace_id) between 1 and 128),
  weight                  integer not null default 1 check (weight between 1 and 100),
  api_rate_per_sec        numeric check (api_rate_per_sec is null or (api_rate_per_sec > 0 and api_rate_per_sec <= 100000)),
  api_burst               integer check (api_burst is null or api_burst between 1 and 100000),
  max_concurrent_requests integer check (max_concurrent_requests is null or max_concurrent_requests between 1 and 10000),
  max_active_operations   integer check (max_active_operations is null or max_active_operations between 1 and 100000),
  max_queued_jobs         integer check (max_queued_jobs is null or max_queued_jobs between 1 and 1000000),
  version                 integer not null default 1 check (version >= 1),
  updated_by              text not null check (char_length(updated_by) between 1 and 128),
  updated_at              timestamptz not null default clock_timestamp()
);

create index if not exists runner_jobs_ws_queued on platform.runner_jobs (workspace_id) where status = 'queued';

alter table platform.ops_maintenance enable row level security;
alter table platform.ops_maintenance_history enable row level security;
alter table platform.tenant_quotas enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['ops_maintenance','ops_maintenance_history','tenant_quotas'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.ops_maintenance to service_role;
    grant select,insert on table platform.ops_maintenance_history to service_role;
    grant select,insert,update,delete on table platform.tenant_quotas to service_role;
  end if;
end
$$;
`,
} as const;
