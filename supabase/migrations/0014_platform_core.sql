-- Zenith platform control store (ADR-0002) — schema `platform`.
--
-- GENERATED FILE — DO NOT EDIT.
-- Source:      src/lib/controlplane/db/migrations/*.ts
-- Regenerate:  npx tsx scripts/platform/emit-sql.ts
-- Verified by: tests/controlplane/migrations.test.ts (byte-for-byte)
--
-- Applied by the operator (Supabase SQL editor, or psql against
-- ZENITH_PLATFORM_DB_URL) or by `npx tsx scripts/platform/migrate.ts`, which
-- reaches the same end state through the same ledger. Idempotent: re-applying
-- is a no-op. The application never runs DDL against Postgres; it checks
-- `platform.schema_migrations` on start and refuses to run when it is behind.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that reads or writes these tables.
-- `platform` must never be added to the Data API's exposed schemas.

create schema if not exists platform;

create table if not exists platform.schema_migrations (
  version    integer     not null primary key,
  name       text        not null,
  applied_at timestamptz not null default now(),
  checksum   text        not null check (checksum ~ '^[0-9a-f]{64}$')
);

-- ============================ migration 1: core ============================

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

insert into platform.schema_migrations (version, name, checksum)
values (1, 'core', 'ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764')
on conflict (version) do nothing;

-- ============================ migration 2: reconcile ============================

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

insert into platform.schema_migrations (version, name, checksum)
values (2, 'reconcile', 'af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0')
on conflict (version) do nothing;

-- ============================ migration 3: machine_requests ============================

/* ------------------------ zenithd requests (mirror of runner_jobs) ------------------------ */

create table if not exists platform.machine_requests (
  id           text        not null primary key,   -- the signed envelope's jti (mreq_…)
  machine_id   text        not null,
  workspace_id text        not null,
  operation_id text        not null,
  operation    text        not null,               -- the machine operation (also the grant's capability)
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
  foreign key (workspace_id, machine_id)   references platform.machines (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists machine_requests_queue on platform.machine_requests (machine_id, created_at, id) where status = 'queued';
create index if not exists machine_requests_ws_op on platform.machine_requests (workspace_id, operation_id);
create index if not exists machine_requests_inflight on platform.machine_requests (lease_until) where status in ('claimed','running');

create table if not exists platform.machine_request_logs (
  id           bigint generated always as identity primary key,
  request_id   text        not null,
  workspace_id text        not null,
  batch_seq    integer     not null,
  line_no      integer     not null,
  ts           timestamptz not null,
  stream       text        not null check (stream in ('stdout','stderr','info')),
  line         text        not null check (char_length(line) <= 8192),
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (request_id, batch_seq, line_no),
  foreign key (workspace_id, request_id) references platform.machine_requests (workspace_id, id) on delete cascade
);
create index if not exists machine_request_logs_ws_req on platform.machine_request_logs (workspace_id, request_id, id);

insert into platform.schema_migrations (version, name, checksum)
values (3, 'machine_requests', 'e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6')
on conflict (version) do nothing;

-- ============================ migration 4: approval_rounds ============================

alter table platform.operations
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  drop constraint if exists approvals_operation_id_approver_id_key;
create unique index if not exists approvals_op_round_approver
  on platform.approvals (operation_id, approval_round, approver_id);

insert into platform.schema_migrations (version, name, checksum)
values (4, 'approval_rounds', '1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311')
on conflict (version) do nothing;

-- ============================ migration 5: read_jobs ============================

alter table platform.runner_jobs alter column operation_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_capability') then
    alter table platform.runner_jobs add constraint runner_jobs_read_capability
      check (operation_id is not null or capability in ('infrastructure.observe', 'topology.read', 'logs.read', 'metrics.read', 'traces.read', 'events.read', 'incident.investigate', 'cost.estimate', 'firewall.inspect', 'infrastructure.plan', 'placement.solve', 'machine.inspect', 'process.list', 'service.status', 'container.list', 'container.inspect', 'container.logs', 'file.read', 'network.portCheck', 'network.dnsCheck', 'system.metrics', 'system.logs'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_expiry') then
    alter table platform.runner_jobs add constraint runner_jobs_read_expiry
      check (operation_id is not null or expires_at <= created_at + interval '1 hour');
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (5, 'read_jobs', 'e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387')
on conflict (version) do nothing;

-- ============================ migration 6: github_sources ============================

create table if not exists platform.github_source_bindings (
  workspace_id text primary key,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  version integer not null check (version > 0),
  bound_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.github_install_intents (
  workspace_id text not null,
  state_digest text not null check (state_digest ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  browser_digest text not null check (browser_digest ~ '^[a-f0-9]{64}$'),
  owner text not null,
  repo text not null,
  expected_version integer not null check (expected_version >= 0),
  installation_id bigint,
  phase text not null check (phase in ('install', 'oauth')),
  expires_at timestamptz not null,
  primary key (workspace_id, state_digest)
);

insert into platform.schema_migrations (version, name, checksum)
values (6, 'github_sources', '0e256ace8f784b996b2e6687dc42bb4705f91c4579b4ecb1da38987d9f68d78d')
on conflict (version) do nothing;

-- ============================ migration 7: plan_artifacts ============================

create table if not exists platform.plan_artifacts (
  workspace_id text not null,
  operation_id text not null,
  manifest jsonb not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv) = 16),
  auth_tag text not null check (length(auth_tag) = 24),
  ciphertext text not null check (length(ciphertext) between 1 and 30000000),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (manifest->>'workspaceId' = workspace_id and manifest->>'operationId' = operation_id and manifest->>'planDigest' = plan_digest)
);
create table if not exists platform.plan_artifact_associations (
  workspace_id text not null,
  operation_id text not null,
  source_operation_id text not null,
  source_evidence_id text not null,
  source_manifest_digest text not null,
  source_raw_sha256 text not null,
  proposal_digest text not null,
  input_digest text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, source_operation_id) references platform.plan_artifacts (workspace_id, operation_id),
  check (operation_id <> source_operation_id)
);
create table if not exists platform.plan_artifact_uses (
  workspace_id text not null,
  operation_id text not null,
  phase text not null default 'ready' check (phase in ('ready','claimed','dispatched','succeeded','uncertain','expired')),
  attempt_id text,
  holder text,
  fence_token bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create or replace function platform.immutable_plan_artifact() returns trigger language plpgsql as $$
begin
  raise exception 'Immutable plan artifact cannot be modified or deleted' using errcode = '23514';
end
$$;
drop trigger if exists immutable_plan_artifact on platform.plan_artifacts;
create trigger immutable_plan_artifact before update or delete on platform.plan_artifacts
for each row execute function platform.immutable_plan_artifact();
drop trigger if exists immutable_plan_artifact_association on platform.plan_artifact_associations;
create trigger immutable_plan_artifact_association before update or delete on platform.plan_artifact_associations
for each row execute function platform.immutable_plan_artifact();
create index if not exists plan_artifacts_expiry on platform.plan_artifacts (expires_at);
-- Canonical schema-6 upgrades may use a different migration owner from the emitted bootstrap.
-- Harden only these new authority tables; existing/custom role policy remains operator-owned.
alter table platform.plan_artifacts enable row level security;
alter table platform.plan_artifact_associations enable row level security;
alter table platform.plan_artifact_uses enable row level security;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (7, 'plan_artifacts', 'eb445d8479b4b8ba8c9c6e8df38fb95c3f9ca59f8949218e3c07f68727f62ae3')
on conflict (version) do nothing;

-- ============================ migration 8: build_launches ============================

create table if not exists platform.build_launches (
  workspace_id text not null,
  operation_id text not null,
  service_address text not null,
  environment_id text not null,
  attempt_id text not null,
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  fence_token bigint not null,
  phase text not null default 'dispatched' check (phase in ('dispatched','accepted','terminal')),
  build_id text,
  request_ids jsonb,
  terminal_status text check (terminal_status in ('SUCCEEDED','FAILED','FAULT','TIMED_OUT','STOPPED')),
  provider_finished_at timestamptz,
  terminal_request_id text,
  created_at timestamptz not null default clock_timestamp(),
  accepted_at timestamptz,
  observed_at timestamptz,
  primary key (workspace_id, operation_id, service_address),
  unique (workspace_id, build_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding ?& array['workspaceId','operationId','environmentId','serviceAddress']
    and binding->>'workspaceId' = workspace_id and binding->>'operationId' = operation_id
    and binding->>'environmentId' = environment_id and binding->>'serviceAddress' = service_address),
  check ((phase = 'dispatched' and build_id is null and request_ids is null and accepted_at is null)
    or (phase in ('accepted','terminal') and build_id is not null and accepted_at is not null and request_ids is not null
      and jsonb_typeof(request_ids) = 'array' and jsonb_array_length(request_ids) > 0)),
  check ((phase <> 'terminal' and terminal_status is null and provider_finished_at is null and terminal_request_id is null and observed_at is null)
    or (phase = 'terminal' and terminal_status is not null and provider_finished_at is not null and terminal_request_id is not null and observed_at is not null))
);
create or replace function platform.immutable_build_launch() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Build launch inventory cannot be deleted' using errcode = '23514';
  end if;
  if (to_jsonb(NEW) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    is distinct from (to_jsonb(OLD) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    or (OLD.phase = 'dispatched' and NEW.phase not in ('dispatched','accepted'))
    or (OLD.phase = 'accepted' and NEW.phase not in ('accepted','terminal'))
    or (OLD.phase = 'terminal' and to_jsonb(NEW) is distinct from to_jsonb(OLD))
    or (OLD.build_id is not null and (NEW.build_id is distinct from OLD.build_id
      or NEW.request_ids is distinct from OLD.request_ids or NEW.accepted_at is distinct from OLD.accepted_at)) then
    raise exception 'Build launch identity and receipts are immutable' using errcode = '23514';
  end if;
  return NEW;
end
$$;
drop trigger if exists immutable_build_launch on platform.build_launches;
create trigger immutable_build_launch before update or delete on platform.build_launches
for each row execute function platform.immutable_build_launch();
create index if not exists build_launches_environment on platform.build_launches (workspace_id, environment_id, phase);
alter table platform.build_launches enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.build_launches from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update on table platform.build_launches to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (8, 'build_launches', '90a025fd0c76ee84b14a26c9d8b1794e215ececec24333848904c22bc0f86e9d')
on conflict (version) do nothing;

-- ============================ migration 9: github_revocation ============================

alter table platform.github_source_bindings add column if not exists revoked_at timestamptz;
alter table platform.github_source_bindings add column if not exists revoked_by text;
create table if not exists platform.github_binding_events (
  workspace_id text not null,
  version integer not null check (version > 0),
  action text not null check (action in ('bound', 'revoked')),
  actor_id text not null,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, version),
  foreign key (workspace_id) references platform.github_source_bindings (workspace_id)
);
-- This table records changes after this migration, never reconstructed history.
alter table platform.github_binding_events enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_binding_events from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table platform.github_binding_events to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (9, 'github_revocation', '7d00eb79279b57c682dda67af0a5eaffc5ff3825d5e6a370235dd0dfdb502060')
on conflict (version) do nothing;

-- ============================ migration 10: github_deliveries ============================

-- Old callbacks have no signed-event fence. Integration must refuse their
-- OAuth transition/consumption until a new browser intent is authorized.
alter table platform.github_install_intents add column if not exists app_id text
  check (app_id ~ '^[1-9][0-9]{0,15}$');
alter table platform.github_install_intents add column if not exists installation_generation bigint
  check (installation_generation >= 0);
create table if not exists platform.github_webhook_installation_epochs (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  installation_id bigint not null check (installation_id > 0),
  generation bigint not null default 0 check (generation >= 0),
  primary key (app_id, installation_id)
);
create table if not exists platform.github_webhook_deliveries (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  delivery_id text not null check (delivery_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  event text not null,
  action text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_ids bigint[] not null,
  revoked_count integer not null default 0 check (revoked_count >= 0),
  replayed boolean not null default false,
  received_at timestamptz not null default clock_timestamp(),
  primary key (app_id, delivery_id),
  check ((event = 'installation' and action in ('deleted', 'suspend') and cardinality(repository_ids) = 0)
    or (event = 'installation_repositories' and action = 'removed' and cardinality(repository_ids) between 1 and 1000)),
  check (0 < all(repository_ids))
);
-- Signed body replay may change the unsigned delivery GUID. The installation
-- epoch lock serializes digest checks; aliases retain their own durable receipt.
create index if not exists github_webhook_deliveries_body
  on platform.github_webhook_deliveries (app_id, body_sha256);
alter table platform.github_webhook_installation_epochs enable row level security;
alter table platform.github_webhook_deliveries enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (10, 'github_deliveries', 'a4436e385563b8bd3b3528708b1db757c5a9872e1927dbd8ef5bd595e1e62bfd')
on conflict (version) do nothing;

-- ============================ hardening (Supabase roles) ============================

do $$
declare
  t record;
  r text;
begin
  for t in select tablename from pg_tables where schemaname = 'platform' loop
    execute format('alter table platform.%I enable row level security', t.tablename);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on all tables in schema platform from %I', r);
      execute format('revoke all on all sequences in schema platform from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on all tables in schema platform to service_role;
    grant usage, select, update on all sequences in schema platform to service_role;
    alter default privileges in schema platform grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema platform grant usage, select, update on sequences to service_role;
  end if;
end
$$;
