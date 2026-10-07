/**
 * Bounded coding-agent runs (PROD-MACH-06).
 *
 * One row per run. `limits` and `usage` hold the five budgets (input tokens,
 * output tokens, tool calls, wall time, estimated spend in micro-USD); `checkpoint`
 * holds the resumable conversation state written after every model turn and
 * tool batch, so a hard stop (budget, crash, abort) loses nothing. `result` is
 * the stored proposal artifact (manifest + digest) the model produced: it is
 * data, never authority. `proposal_operation_id` links it to the capability
 * broker operation that a person or policy must settle before anything adopts it.
 */
export const migration0037CodingAgentRuns = {
  version: 37,
  name: "coding_agent_runs",
  sql: `
create table if not exists platform.coding_agent_runs (
  id                    text primary key,
  workspace_id          text not null,
  project_id            text,
  environment_id        text,
  created_by            text not null,
  status                text not null check (status in ('running','completed','budget_exhausted','failed','cancelled')),
  stop_reason           text,
  model                 text not null,
  task                  text not null,
  source                jsonb not null,
  limits                jsonb not null,
  usage                 jsonb not null,
  checkpoint            jsonb not null,
  result                jsonb,
  proposal_operation_id text,
  version               integer not null default 1 check (version >= 1),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp(),
  check (octet_length(checkpoint::text) <= 2097152)
);
create index if not exists coding_agent_runs_ws on platform.coding_agent_runs(workspace_id, created_at desc);
alter table platform.coding_agent_runs enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.coding_agent_runs from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.coding_agent_runs from service_role;
    grant select,insert,update on table platform.coding_agent_runs to service_role;
  end if;
end
$$;
`,
} as const;
