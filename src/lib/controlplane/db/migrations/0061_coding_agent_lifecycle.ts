/** Disposable analysis payloads and non-secret execution-worker capability leases. */
export const migration0061CodingAgentLifecycle = {
  version: 61,
  name: "coding_agent_lifecycle",
  sql: `
alter table platform.coding_agent_runs add column if not exists payload_expires_at timestamptz not null default (clock_timestamp() + interval '7 days');
alter table platform.coding_agent_runs add column if not exists payload_purged_at timestamptz;
alter table platform.coding_agent_runs add column if not exists request_digest text;
create index if not exists coding_agent_payload_expiry on platform.coding_agent_runs(payload_expires_at) where payload_purged_at is null;
create table if not exists platform.coding_agent_workers (
  worker_id text not null,
  worker_scope text not null,
  model_ready boolean not null,
  seen_at timestamptz not null default clock_timestamp(),
  primary key(worker_scope,worker_id)
);
create table if not exists platform.coding_agent_workspace_limits (
  workspace_id text primary key,
  concurrent_runs integer not null default 3 check(concurrent_runs between 1 and 20),
  daily_spend_micro_usd bigint not null default 20000000 check(daily_spend_micro_usd between 100000 and 1000000000)
);
alter table platform.coding_agent_workers enable row level security;
alter table platform.coding_agent_workspace_limits enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.coding_agent_workers,platform.coding_agent_workspace_limits from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.coding_agent_workers,platform.coding_agent_workspace_limits to service_role;
  end if;
end $$;
`,
} as const;
