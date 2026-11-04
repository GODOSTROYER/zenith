/**
 * Migration 1 — the platform control store's core schema (ADR-0002).
 *
 * Conventions, in one place:
 *  - Everything lives in schema `platform`; every statement names it. Nothing
 *    here touches `public` (the product store) or `hosted`/`agent`.
 *  - Idempotent (`if not exists`), so the emitted Supabase file may be applied
 *    twice and an operator who half-applied it can simply re-run it.
 *  - Timestamps are `timestamptz` and every default/comparison uses
 *    `clock_timestamp()`, the database's wall clock — never a client clock and
 *    never `now()` (which is frozen at transaction start and would make a lease
 *    look fresher than it is inside a long transaction).
 *  - Ids are application-generated text (`op_<uuid>`, …). Fence tokens and
 *    sequences are `bigint`; the executor hands them to JS as numbers.
 *  - Tenancy: every tenant-owned table has `workspace_id text not null` and an
 *    index that leads with it. Child tables reference their parent through a
 *    composite `(workspace_id, id)` key, so a row can never point at another
 *    tenant's parent even if application code got it wrong.
 *  - Statuses are `check` constraints, so a typo cannot create a new state.
 *  - No secret values anywhere: columns hold references, digests and redacted
 *    summaries (see `../secrets.ts`, enforced in the repositories).
 *
 * This text is hashed into the ledger checksum. Once released, never edit it;
 * add migration 2.
 */
export const migration0001Core = {
  version: 1,
  name: "core",
  sql: `
/* ------------------------------- operations -------------------------------- */

create table if not exists platform.operations (
  seq               bigint generated always as identity,
  id                text        not null primary key,
  workspace_id      text        not null,
  project_id        text,
  environment_id    text,
  resource_id       text,
  capability        text        not null,
  principal         jsonb       not null,
  status            text        not null check (status in (
                      'proposed','awaiting_approval','approved','rejected','denied',
                      'queued','running','succeeded','failed','uncertain','cancelled','expired')),
  proposal          jsonb       not null,
  proposal_digest   text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  input_digest      text        not null check (input_digest ~ '^[0-9a-f]{64}$'),
  plan_digest       text,
  policy_decision_id text,
  approval_required boolean     not null default false,
  idempotency_key   text,
  workflow_id       text,
  runner_job_id     text,
  -- the environment lease this execution runs under, and its fence token
  lease_scope       text,
  fence_token       bigint,
  -- the execution's own heartbeat: a running operation past lease_until is uncertain
  lease_holder      text,
  lease_until       timestamptz,
  correlation_id    text        not null,
  result            jsonb,
  error             text,
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  started_at        timestamptz,
  finished_at       timestamptz,
  expires_at        timestamptz not null,
  unique (seq),
  unique (workspace_id, id)
);
create index if not exists operations_ws_seq      on platform.operations (workspace_id, seq desc);
create index if not exists operations_ws_env_seq  on platform.operations (workspace_id, environment_id, seq desc);
create index if not exists operations_ws_status   on platform.operations (workspace_id, status);
create index if not exists operations_running     on platform.operations (lease_until) where status = 'running';
create index if not exists operations_pending_expiry
  on platform.operations (expires_at) where status in ('proposed','awaiting_approval','approved','queued');

/* ----------------------------- idempotency keys ----------------------------- */

create table if not exists platform.idempotency_keys (
  workspace_id text        not null,
  key          text        not null,
  request_hash text        not null,
  operation_id text,
  response     jsonb,
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  primary key (workspace_id, key),
  -- deferred: the key row is claimed first, the operation row inserted after it
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
    deferrable initially deferred
);
create index if not exists idempotency_keys_expiry on platform.idempotency_keys (expires_at);

/* --------------------------------- leases ---------------------------------- */

-- One row per scope, kept forever: fence_token must be strictly increasing per
-- scope, so a released or expired lease keeps its row (and its counter).
create table if not exists platform.leases (
  scope        text        not null primary key,
  workspace_id text,
  holder       text        not null,
  fence_token  bigint      not null check (fence_token >= 1),
  acquired_at  timestamptz not null default clock_timestamp(),
  renewed_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  released_at  timestamptz
);
create index if not exists leases_ws on platform.leases (workspace_id) where workspace_id is not null;

/* -------------------------------- approvals -------------------------------- */

create table if not exists platform.approvals (
  id              text        not null primary key,
  operation_id    text        not null,
  workspace_id    text        not null,
  proposal_digest text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  decision        text        not null check (decision in ('approve','reject')),
  approver        jsonb       not null,
  approver_id     text        not null,
  approver_role   text        not null check (approver_role in ('viewer','editor','admin')),
  reason          text,
  policy_version  text        not null,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  -- one decision per approver per operation
  unique (operation_id, approver_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists approvals_ws_op on platform.approvals (workspace_id, operation_id);

/* ---------------------------- policy decisions ----------------------------- */

create table if not exists platform.policy_decisions (
  id             text        not null primary key,
  workspace_id   text        not null,
  operation_id   text,
  policy_version text        not null,
  input_digest   text        not null check (input_digest ~ '^[0-9a-f]{64}$'),
  outcome        text        not null check (outcome in ('allow','deny','require_approval')),
  reasons        jsonb       not null default '[]'::jsonb,
  approval       jsonb,
  constraints    jsonb,
  evaluated_at   timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists policy_decisions_ws_op on platform.policy_decisions (workspace_id, operation_id);

/* ---------------------------- capability grants ---------------------------- */

create table if not exists platform.capability_grants (
  jti          text        not null primary key,
  workspace_id text        not null,
  operation_id text        not null,
  capability   text        not null,
  audience     text        not null,
  issued_at    timestamptz not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  revoked_at   timestamptz,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists capability_grants_ws_op on platform.capability_grants (workspace_id, operation_id);

/* ---------------------------------- events --------------------------------- */

create table if not exists platform.events (
  seq            bigint generated always as identity primary key,
  id             text        not null unique,
  ts             timestamptz not null default clock_timestamp(),
  type           text        not null,
  workspace_id   text        not null,
  project_id     text,
  environment_id text,
  resource_id    text,
  operation_id   text,
  correlation_id text        not null,
  causation_id   text,
  actor          jsonb,
  data           jsonb       not null default '{}'::jsonb
);
create index if not exists events_ws_seq  on platform.events (workspace_id, seq);
create index if not exists events_ws_op   on platform.events (workspace_id, operation_id, seq) where operation_id is not null;
create index if not exists events_ws_corr on platform.events (workspace_id, correlation_id, seq);

/* --------------------------------- evidence -------------------------------- */

create table if not exists platform.evidence (
  id           text        not null primary key,
  workspace_id text        not null,
  operation_id text,
  incident_id  text,
  kind         text        not null check (kind in (
                 'tofu_plan','tofu_apply','observation','verification','http_probe','log_query',
                 'metric_query','policy_decision','build','machine_request','runner_job')),
  digest       text        not null check (digest ~ '^[0-9a-f]{64}$'),
  summary      jsonb       not null default '{}'::jsonb,
  blob_ref     text,
  simulated    boolean     not null,
  created_at   timestamptz not null default clock_timestamp()
);
create index if not exists evidence_ws_op  on platform.evidence (workspace_id, operation_id) where operation_id is not null;
create index if not exists evidence_ws_inc on platform.evidence (workspace_id, incident_id) where incident_id is not null;

/* ------------------------ environment / workspace policy -------------------- */

create table if not exists platform.environment_settings (
  environment_id text        not null primary key,
  workspace_id   text        not null,
  autonomy_level smallint    not null check (autonomy_level between 0 and 5),
  policy_params  jsonb       not null default '{}'::jsonb,
  version        integer     not null default 1,
  updated_by     text        not null,
  updated_at     timestamptz not null default clock_timestamp()
);
create index if not exists environment_settings_ws on platform.environment_settings (workspace_id);

create table if not exists platform.workspace_policy (
  workspace_id text        not null primary key,
  params       jsonb       not null default '{}'::jsonb,
  version      integer     not null default 1,
  updated_by   text        not null,
  updated_at   timestamptz not null default clock_timestamp()
);

/* --------------------------- provider connections -------------------------- */

create table if not exists platform.provider_connections (
  id                  text        not null primary key,
  workspace_id        text        not null,
  legacy_connection_id text,
  provider            text        not null,
  mode                text        not null,
  -- non-secret identifiers only (role ARNs, pool ids, tenant ids); never key material
  config              jsonb       not null,
  status              text        not null check (status in ('pending_verification','verified','failed','revoked')),
  verified_at         timestamptz,
  verification_detail text,
  created_by          text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  revoked_at          timestamptz,
  unique (workspace_id, id)
);
create index if not exists provider_connections_ws on platform.provider_connections (workspace_id, created_at desc);

/* --------------------------------- resources ------------------------------- */

create table if not exists platform.resources (
  id             text        not null primary key,
  workspace_id   text        not null,
  project_id     text,
  environment_id text        not null,
  address        text        not null,
  kind           text        not null,
  provider       text        not null,
  region         text,
  native_type    text        not null,
  ownership      text        not null check (ownership in ('managed','referenced','external')),
  external_id    text,
  spec_digest    text        not null check (spec_digest ~ '^[0-9a-f]{64}$'),
  spec           jsonb       not null default '{}'::jsonb,
  depends_on     jsonb       not null default '[]'::jsonb,
  origin         jsonb       not null default '[]'::jsonb,
  labels         jsonb       not null default '{}'::jsonb,
  revision_id    text,
  status         text        not null default 'planned' check (status in (
                   'planned','provisioning','active','updating','deleting','deleted','failed','unknown')),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  unique (environment_id, address),
  unique (workspace_id, id)
);
create index if not exists resources_ws_env on platform.resources (workspace_id, environment_id);

-- Observed state: append-only history, pruned to the latest N per resource.
create table if not exists platform.resource_observations (
  id           bigint generated always as identity primary key,
  resource_id  text        not null,
  workspace_id text        not null,
  environment_id text      not null,
  address      text        not null,
  presence     text        not null check (presence in ('present','missing','inaccessible','unknown')),
  external_id  text,
  attributes   jsonb       not null default '{}'::jsonb,
  native       jsonb,
  observed_at  timestamptz not null,
  source       text        not null,
  simulated    boolean     not null,
  error        text,
  recorded_at  timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, resource_id) references platform.resources (workspace_id, id) on delete cascade
);
create index if not exists resource_observations_latest
  on platform.resource_observations (resource_id, observed_at desc, id desc);
create index if not exists resource_observations_ws_env on platform.resource_observations (workspace_id, environment_id);

-- Runtime state: the latest per resource.
create table if not exists platform.resource_runtime (
  resource_id  text        not null primary key,
  workspace_id text        not null,
  environment_id text      not null,
  address      text        not null,
  health       text        not null check (health in ('healthy','degraded','unhealthy','unknown')),
  counts       jsonb       not null default '{}'::jsonb,
  signals      jsonb       not null default '[]'::jsonb,
  observed_at  timestamptz not null,
  source       text        not null,
  simulated    boolean     not null,
  updated_at   timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, resource_id) references platform.resources (workspace_id, id) on delete cascade
);
create index if not exists resource_runtime_ws_env on platform.resource_runtime (workspace_id, environment_id);

create table if not exists platform.drift_reports (
  id             text        not null primary key,
  workspace_id   text        not null,
  environment_id text        not null,
  graph_digest   text        not null,
  computed_at    timestamptz not null,
  findings       jsonb       not null default '[]'::jsonb,
  unobserved     jsonb       not null default '[]'::jsonb,
  simulated      boolean     not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index if not exists drift_reports_env on platform.drift_reports (workspace_id, environment_id, computed_at desc);

/* ------------------------- runners, tokens, jobs, logs ---------------------- */

create table if not exists platform.runners (
  id                text        not null primary key,
  workspace_id      text        not null,
  name              text        not null,
  status            text        not null default 'active' check (status in ('active','revoked')),
  protocol          text        not null default 'zenith.runner/v1',
  public_key        text        not null,
  version           text,
  capabilities      jsonb       not null default '[]'::jsonb,
  labels            jsonb       not null default '{}'::jsonb,
  host              jsonb       not null default '{}'::jsonb,
  registered_at     timestamptz not null default clock_timestamp(),
  last_heartbeat_at timestamptz,
  revoked_at        timestamptz,
  unique (workspace_id, id)
);
create index if not exists runners_ws on platform.runners (workspace_id);

-- Only the SHA-256 of a registration token is ever stored.
create table if not exists platform.runner_registration_tokens (
  token_hash   text        not null primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id text        not null,
  kind         text        not null check (kind in ('runner','machine')),
  binding      jsonb       not null default '{}'::jsonb,
  created_by   text        not null,
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null check (expires_at <= created_at + interval '61 minutes'),
  used_at      timestamptz,
  used_by      text
);
create index if not exists runner_registration_tokens_ws on platform.runner_registration_tokens (workspace_id);

create table if not exists platform.runner_jobs (
  id           text        not null primary key,   -- the signed envelope's jti
  runner_id    text        not null,
  workspace_id text        not null,
  operation_id text        not null,
  kind         text        not null,
  capability   text        not null,
  envelope     text        not null,
  status       text        not null default 'queued' check (status in (
                 'queued','claimed','running','succeeded','failed','rejected','timed_out','expired','cancelled')),
  lease_until  timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default clock_timestamp(),
  claimed_at   timestamptz,
  started_at   timestamptz,
  expires_at   timestamptz not null,
  settled_at   timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, runner_id)    references platform.runners (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists runner_jobs_queue on platform.runner_jobs (runner_id, created_at, id) where status = 'queued';
create index if not exists runner_jobs_ws_op on platform.runner_jobs (workspace_id, operation_id);
create index if not exists runner_jobs_inflight on platform.runner_jobs (lease_until) where status in ('claimed','running');

create table if not exists platform.runner_job_logs (
  id           bigint generated always as identity primary key,
  job_id       text        not null,
  workspace_id text        not null,
  batch_seq    integer     not null,
  line_no      integer     not null,
  ts           timestamptz not null,
  stream       text        not null check (stream in ('stdout','stderr','info')),
  line         text        not null check (char_length(line) <= 8192),
  recorded_at  timestamptz not null default clock_timestamp(),
  -- a retried POST of the same batch does not duplicate lines
  unique (job_id, batch_seq, line_no),
  foreign key (workspace_id, job_id) references platform.runner_jobs (workspace_id, id) on delete cascade
);
create index if not exists runner_job_logs_ws_job on platform.runner_job_logs (workspace_id, job_id, id);

-- Replay protection for signed agent requests (RUNNER-PROTOCOL section 3).
create table if not exists platform.agent_nonces (
  agent_id text        not null,
  nonce    text        not null,
  seen_at  timestamptz not null default clock_timestamp(),
  primary key (agent_id, nonce)
);
create index if not exists agent_nonces_seen on platform.agent_nonces (seen_at);

/* ---------------------------------- machines ------------------------------- */

create table if not exists platform.machines (
  id                text        not null primary key,
  workspace_id      text        not null,
  environment_id    text,
  address           text,
  name              text        not null,
  transport         text        not null check (transport in (
                      'aws_ssm','kubernetes','azure_run_command','gcp_os_management','zenithd')),
  target_id         text        not null,
  status            text        not null default 'active' check (status in ('pending','active','revoked')),
  public_key        text,
  version           text,
  capabilities      jsonb       not null default '[]'::jsonb,
  labels            jsonb       not null default '{}'::jsonb,
  host              jsonb       not null default '{}'::jsonb,
  registered_at     timestamptz not null default clock_timestamp(),
  last_heartbeat_at timestamptz,
  revoked_at        timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, transport, target_id)
);
create index if not exists machines_ws_env on platform.machines (workspace_id, environment_id);

/* ---------------------------- incidents, investigations -------------------- */

create table if not exists platform.incidents (
  id             text        not null primary key,
  workspace_id   text        not null,
  environment_id text,
  title          text        not null,
  status         text        not null default 'open' check (status in ('open','investigating','mitigating','resolved')),
  severity       text        not null check (severity in ('low','medium','high','critical')),
  source         text        not null,
  summary        text,
  correlation_id text        not null,
  document       jsonb       not null default '{}'::jsonb,
  opened_at      timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  resolved_at    timestamptz,
  unique (workspace_id, id)
);
create index if not exists incidents_ws_status on platform.incidents (workspace_id, status, opened_at desc);

create table if not exists platform.investigations (
  id             text        not null primary key,
  workspace_id   text        not null,
  incident_id    text,
  environment_id text        not null,
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  simulated      boolean     not null,
  -- the full Investigation value (path, evidence, hypotheses, recent changes)
  document       jsonb       not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index if not exists investigations_ws_inc on platform.investigations (workspace_id, incident_id);
create index if not exists investigations_ws_env on platform.investigations (workspace_id, environment_id, started_at desc);

/* ------------------------------- cost estimates ---------------------------- */

create table if not exists platform.cost_estimates (
  id              text        not null primary key,
  workspace_id    text        not null,
  project_id      text,
  environment_id  text,
  operation_id    text,
  catalog_version text        not null,
  monthly_usd     double precision not null,
  -- the full CostEstimate value; always an estimate, never an invoice
  estimate        jsonb       not null,
  computed_at     timestamptz not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index if not exists cost_estimates_ws_env on platform.cost_estimates (workspace_id, environment_id, computed_at desc);
create index if not exists cost_estimates_ws_op  on platform.cost_estimates (workspace_id, operation_id) where operation_id is not null;
`,
};
