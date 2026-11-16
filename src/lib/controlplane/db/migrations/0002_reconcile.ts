/**
 * Migration 2 — reconciliation controller state (`src/lib/reconcile`).
 *
 * `platform.reconcile_state` is one row per environment the controller
 * reconciles: the environment's descriptor (class, provider, region,
 * connection — the facts the scheduler filters on, registered once when the
 * environment is deployed or connected), its backoff schedule, the claim a
 * pass holds while it works, and the first-seen instant of every open drift
 * finding (so `drift.detected` and `drift.cleared` share a correlation id).
 *
 * Same conventions as migration 1: everything in schema `platform`, idempotent,
 * tenancy explicit (`workspace_id` on the row, an environment belongs to one
 * workspace for life), no secret values, database-independent of any client
 * clock (the controller passes its own `now` so schedules are deterministic in
 * tests; leases elsewhere keep using the database clock).
 *
 * The partial index on `operations` backs the stateless "which environments
 * finished a deploy recently" pull the controller uses to bring an environment's
 * next run forward; without it that query would scan the whole ledger.
 *
 * This text is hashed into the ledger checksum. Once released, never edit it;
 * add migration 3.
 */
export const migration0002Reconcile = {
  version: 2,
  name: "reconcile",
  sql: `
/* ----------------------------- reconcile state ----------------------------- */

create table if not exists platform.reconcile_state (
  environment_id       text        not null primary key,
  workspace_id         text        not null,
  project_id           text,
  -- descriptor: what the scheduler filters on (sandbox / no verified connection are not reconciled)
  env_class            text        not null check (env_class in ('sandbox','development','staging','production')),
  provider             text        not null,
  region               text        not null,
  connection_id        text,
  -- schedule: index into the backoff ladder (5 -> 15 -> 60 -> 180 min) and the next run
  step_index           integer     not null default 0 check (step_index >= 0),
  next_run_at          timestamptz not null,
  priority             integer     not null default 0,
  last_run_at          timestamptz,
  last_changed_at      timestamptz,
  last_deploy_at       timestamptz,
  last_graph_digest    text,
  last_outcome         text,
  consecutive_failures integer     not null default 0 check (consecutive_failures >= 0),
  -- the claim a pass holds while it reconciles this environment
  claimed_by           text,
  claimed_until        timestamptz,
  -- open findings: "<class>|<address>" -> first-seen timestamp (correlation ids)
  finding_since        jsonb       not null default '{}'::jsonb,
  registered_at        timestamptz not null,
  updated_at           timestamptz not null,
  unique (workspace_id, environment_id)
);
create index if not exists reconcile_state_due on platform.reconcile_state (next_run_at);
create index if not exists reconcile_state_ws on platform.reconcile_state (workspace_id);

create index if not exists operations_deploy_finished
  on platform.operations (finished_at)
  where status = 'succeeded' and capability in ('deployment.deploy', 'deployment.rollback', 'infrastructure.apply');
`,
};
