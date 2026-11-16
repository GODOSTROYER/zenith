/**
 * Provider-reported actual spend snapshots (PROD-COST-01). Kept apart from
 * `platform.cost_estimates`: an estimate is modeled, a snapshot is what the
 * provider's billing data said, and neither table can hold the other. The
 * document is the `ActualSpend` value (`kind: "actual_spend"`) with the SHA-256
 * of the provider response it came from.
 */
export const migration0037ActualSpend = {
  version: 37,
  name: "actual_spend",
  sql: `
create table if not exists platform.actual_spend_snapshots (
  id              text        not null primary key,
  workspace_id    text        not null,
  project_id      text,
  environment_id  text,
  provider        text        not null check (provider in ('aws','gcp','azure','oci')),
  scope           text        not null check (length(scope) between 1 and 300),
  period_start    date        not null,
  period_end      date        not null check (period_end > period_start),
  total_usd       numeric(18,6) not null,
  finalization    text        not null check (finalization in ('provisional','final')),
  response_sha256 text        not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot        jsonb       not null check (snapshot->>'kind' = 'actual_spend'),
  retrieved_at    timestamptz not null,
  recorded_by     text        not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (workspace_id, provider, scope, period_start, period_end, response_sha256)
);
create index if not exists actual_spend_ws_env on platform.actual_spend_snapshots (workspace_id, environment_id, period_start desc, retrieved_at desc);
alter table platform.actual_spend_snapshots enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.actual_spend_snapshots from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.actual_spend_snapshots from service_role;
    grant select,insert on table platform.actual_spend_snapshots to service_role;
  end if;
end
$$;
`,
} as const;
