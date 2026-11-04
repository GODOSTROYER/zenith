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

-- ============================ migration 11: agent_effect_receipts ============================

create table if not exists platform.agent_effect_receipts (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  agent_kind text not null check (agent_kind in ('runner','machine')),
  agent_id text not null check (agent_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_id text not null check (job_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runner_job_id text,
  machine_request_id text,
  operation_id text check (operation_id is null or operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_kind text not null check (job_kind ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  capability text not null check (capability ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  envelope_digest text not null check (envelope_digest ~ '^[a-f0-9]{64}$'),
  agent_key_digest text not null check (agent_key_digest ~ '^[a-f0-9]{64}$'),
  logical_digest text not null check (logical_digest ~ '^[a-f0-9]{64}$'),
  projection_status text not null check (projection_status in ('claimed','running','cancelled','timed_out')),
  reported_status text not null check (reported_status in ('succeeded','failed','rejected','timed_out')),
  claimed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  sealed jsonb not null check (
    jsonb_typeof(sealed) = 'object' and sealed ?& array['v','alg','iv','ct','tag']
    and sealed - 'v' - 'alg' - 'iv' - 'ct' - 'tag' = '{}'::jsonb
    and sealed->'v' = '1'::jsonb and sealed->>'alg' = 'A256GCM'
    and jsonb_typeof(sealed->'alg') = 'string' and jsonb_typeof(sealed->'iv') = 'string'
    and jsonb_typeof(sealed->'tag') = 'string' and jsonb_typeof(sealed->'ct') = 'string'
    and sealed->>'iv' ~ '^[A-Za-z0-9_-]{16}$' and sealed->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    and sealed->>'ct' ~ '^[A-Za-z0-9_-]+$' and octet_length(sealed->>'ct') <= 22369626),
  primary key (workspace_id, agent_kind, job_id),
  check ((agent_kind = 'runner' and runner_job_id is not null and runner_job_id = job_id and machine_request_id is null)
      or (agent_kind = 'machine' and machine_request_id is not null and machine_request_id = job_id and runner_job_id is null)),
  foreign key (workspace_id, runner_job_id) references platform.runner_jobs (workspace_id, id),
  foreign key (workspace_id, machine_request_id) references platform.machine_requests (workspace_id, id)
);
create index if not exists agent_effect_receipts_ws_op on platform.agent_effect_receipts (workspace_id, operation_id);

create or replace function platform.agent_effect_receipt_immutable() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Agent effect receipts cannot be changed or removed';
end $$;
drop trigger if exists agent_effect_receipt_immutable on platform.agent_effect_receipts;
create trigger agent_effect_receipt_immutable before update or delete on platform.agent_effect_receipts
  for each row execute function platform.agent_effect_receipt_immutable();

-- Original signed assignment and the first durable claim remain immutable.
create or replace function platform.runner_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.runner_id,new.operation_id,new.kind,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.runner_id,old.operation_id,old.kind,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original runner assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists runner_assignment_immutable on platform.runner_jobs;
create trigger runner_assignment_immutable before update on platform.runner_jobs
  for each row execute function platform.runner_assignment_immutable();

create or replace function platform.machine_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.machine_id,new.operation_id,new.operation,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.machine_id,old.operation_id,old.operation,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original machine assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists machine_assignment_immutable on platform.machine_requests;
create trigger machine_assignment_immutable before update on platform.machine_requests
  for each row execute function platform.machine_assignment_immutable();

alter table platform.agent_effect_receipts enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.agent_effect_receipts from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The same creator can inherit older emitted default UPDATE/DELETE grants.
    revoke all on table platform.agent_effect_receipts from service_role;
    grant select, insert on table platform.agent_effect_receipts to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (11, 'agent_effect_receipts', 'f6c9d90f69447e430ad9ef2b8368b137b26cadcd05776d689959c99da9e0430b')
on conflict (version) do nothing;

-- ============================ migration 12: workflow_start_intents ============================

create table if not exists platform.workflow_start_intents (
  workspace_id text not null,
  operation_id text not null,
  binding jsonb not null check (octet_length(binding::text) <= 16000),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  observed_start_at timestamptz,
  evidence_digest text check (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding->>'format' = 'zenith.workflow-start.v1'
    and binding->'arguments'->>'workspaceId' = workspace_id
    and binding->'arguments'->>'operationId' = operation_id),
  check ((phase = 'prepared' and attempt_id is null and attempted_at is null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'attempted' and attempt_id is not null and attempted_at is not null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'acknowledged' and attempt_id is not null and attempted_at is not null
      and run_id is not null and observed_start_at is not null and evidence_digest is not null and acknowledged_at is not null))
);
create unique index if not exists workflow_start_intents_temporal_identity on platform.workflow_start_intents
  ((binding->>'endpointDigest'), (binding->>'namespace'), (binding->>'workflowId'));
create or replace function platform.retain_workflow_start_intent() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Workflow start tombstones cannot be deleted' using errcode = '23514';
  end if;
  if (new.workspace_id, new.operation_id, new.binding, new.binding_digest, new.created_at)
    is distinct from (old.workspace_id, old.operation_id, old.binding, old.binding_digest, old.created_at)
    or (old.attempt_id is not null and (new.attempt_id, new.attempted_at) is distinct from (old.attempt_id, old.attempted_at))
    or (old.phase = 'acknowledged' and new is distinct from old)
    or not ((old.phase = 'prepared' and new.phase = 'attempted')
      or (old.phase = 'attempted' and new.phase = 'acknowledged') or new is not distinct from old) then
    raise exception 'Workflow start intent is immutable and cannot be replayed' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_workflow_start_intent on platform.workflow_start_intents;
create trigger retain_workflow_start_intent before update or delete on platform.workflow_start_intents
for each row execute function platform.retain_workflow_start_intent();
alter table platform.workflow_start_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.workflow_start_intents from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- Creator defaults may include TRUNCATE, which bypasses every row trigger.
    -- Remove the complete inherited table grant before admitting only phase DML.
    revoke all on table platform.workflow_start_intents from service_role;
    grant select, insert, update on table platform.workflow_start_intents to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (12, 'workflow_start_intents', '7eaa5e87e594d741e772e0cd9b77010c796d36c2c9ceac41f8f47720c804d811')
on conflict (version) do nothing;

-- ============================ migration 13: approved_source_snapshots ============================

create table if not exists platform.approved_source_snapshots (
  workspace_id text not null,
  operation_id text not null,
  project_id text not null,
  environment_id text not null,
  service_address text not null check (service_address ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=16000),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,operation_id,service_address),
  foreign key (workspace_id,operation_id) references platform.operations(workspace_id,id),
  check ((snapshot ?& array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']
    and snapshot - array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']='{}'::jsonb
    and jsonb_typeof(snapshot->'format')='string'
    and jsonb_typeof(snapshot->'workspaceId')='string'
    and jsonb_typeof(snapshot->'operationId')='string'
    and jsonb_typeof(snapshot->'projectId')='string'
    and jsonb_typeof(snapshot->'environmentId')='string'
    and jsonb_typeof(snapshot->'serviceAddress')='string'
    and jsonb_typeof(snapshot->'serviceSpecDigest')='string'
    and jsonb_typeof(snapshot->'pipelineAddress')='string'
    and jsonb_typeof(snapshot->'pipelineSpecDigest')='string'
    and jsonb_typeof(snapshot->'provider')='string'
    and jsonb_typeof(snapshot->'region')='string'
    and jsonb_typeof(snapshot->'owner')='string'
    and jsonb_typeof(snapshot->'repo')='string'
    and jsonb_typeof(snapshot->'requestedRef')='string'
    and jsonb_typeof(snapshot->'commitSha')='string'
    and jsonb_typeof(snapshot->'dockerfile')='string'
    and jsonb_typeof(snapshot->'dockerfileDigest')='string'
    and jsonb_typeof(snapshot->'recipeDigest')='string'
    and jsonb_typeof(snapshot->'archiveFormat')='string'
    and jsonb_typeof(snapshot->'archiveDigest')='string'
    and snapshot->>'format'='zenith.approved-source.v1'
    and workspace_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and operation_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and project_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and environment_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and snapshot->>'workspaceId'=workspace_id and snapshot->>'operationId'=operation_id
    and snapshot->>'projectId'=project_id and snapshot->>'environmentId'=environment_id
    and snapshot->>'serviceAddress'=service_address
    and snapshot->>'commitSha' ~ '^[a-f0-9]{40}$'
    and snapshot->>'archiveDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'dockerfileDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'recipeDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'serviceSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'pipelineSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'provider' in ('aws','gcp','azure')
    and snapshot->>'archiveFormat'=case when snapshot->>'provider'='aws' then 'zip' else 'tar.gz' end
    and jsonb_typeof(snapshot->'repositoryId')='number'
    and (snapshot->>'repositoryId')::numeric between 1 and 9007199254740991
    and jsonb_typeof(snapshot->'archiveBytes')='number'
    and (snapshot->>'archiveBytes')::numeric between 1 and 33554432
    and snapshot->>'repositoryId' ~ '^[1-9][0-9]{0,15}$' and snapshot->>'archiveBytes' ~ '^[1-9][0-9]{0,7}$'
    and snapshot->>'pipelineAddress' ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'
    and snapshot->>'owner' ~ '^[a-z0-9][a-z0-9-]{0,38}$' and snapshot->>'repo' ~ '^[a-z0-9._-]{1,100}$' and snapshot->>'repo' not in ('.','..')
    and snapshot->>'region' ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and length(snapshot->>'requestedRef') between 1 and 250 and snapshot->>'requestedRef' ~ '^[A-Za-z0-9._+@~-]{1,100}(/[A-Za-z0-9._+@~-]{1,100})*$'
    and snapshot->>'requestedRef' !~ '(^|/)[.]{1,2}(/|$)'
    and length(snapshot->>'dockerfile') between 1 and 200 and snapshot->>'dockerfile' ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
    and position('..' in snapshot->>'dockerfile')=0 and snapshot->>'dockerfile' !~ '(^|/)[.](/|$)'
    and (snapshot->'githubBinding'='null'::jsonb or (
      jsonb_typeof(snapshot->'githubBinding')='object'
      and snapshot->'githubBinding' ?& array['appId','installationId','repositoryId','version']
      and (snapshot->'githubBinding') - array['appId','installationId','repositoryId','version']='{}'::jsonb
      and jsonb_typeof(snapshot->'githubBinding'->'appId')='string' and snapshot->'githubBinding'->>'appId' ~ '^[1-9][0-9]{0,15}$'
      and jsonb_typeof(snapshot->'githubBinding'->'installationId')='number' and snapshot->'githubBinding'->>'installationId' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'installationId')::numeric<=9007199254740991
      and snapshot->'githubBinding'->'repositoryId'=snapshot->'repositoryId'
      and jsonb_typeof(snapshot->'githubBinding'->'version')='number' and snapshot->'githubBinding'->>'version' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'version')::numeric<=9007199254740991
    ))) is true)
);
create or replace function platform.retain_approved_source_snapshot() returns trigger language plpgsql as $$
begin
  if TG_OP='TRUNCATE' or TG_OP='DELETE' or (TG_OP='UPDATE' and new is distinct from old) then
    raise exception 'Approved source records are immutable' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists retain_approved_source_snapshot on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot before update or delete on platform.approved_source_snapshots
for each row execute function platform.retain_approved_source_snapshot();
drop trigger if exists retain_approved_source_snapshot_truncate on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot_truncate before truncate on platform.approved_source_snapshots
for each statement execute function platform.retain_approved_source_snapshot();
alter table platform.approved_source_snapshots enable row level security;
revoke all on platform.approved_source_snapshots from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.approved_source_snapshots from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on platform.approved_source_snapshots from service_role;
    grant select,insert on platform.approved_source_snapshots to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (13, 'approved_source_snapshots', 'eb513c01d41b1f7fbc680715b86699147374d9786aa3e17e355897388ff26e95')
on conflict (version) do nothing;

-- ============================ migration 14: mixed_child_intents ============================

create table if not exists platform.mixed_child_custody (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  partition_id text not null check (partition_id ~ '^[a-f0-9]{64}$'),
  descriptor jsonb not null check (octet_length(descriptor::text) <= 131072),
  descriptor_digest text not null check (descriptor_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, child_operation_id),
  unique (workspace_id, parent_operation_id, child_operation_id, descriptor_digest),
  foreign key (workspace_id, parent_operation_id) references platform.operations(workspace_id,id),
  foreign key (workspace_id, child_operation_id) references platform.operations(workspace_id,id),
  check (parent_operation_id <> child_operation_id),
  check (coalesce((descriptor->>'format' = 'zenith.mixed-child-candidate.v1'
    and descriptor->>'workspaceId' = workspace_id
    and descriptor->'parent'->>'operationId' = parent_operation_id
    and descriptor->'child'->>'operationId' = child_operation_id
    and descriptor->>'partitionId' = partition_id
    and descriptor->'executionEnabled' = 'false'::jsonb
    and descriptor->>'parentEffectCoverage' = 'unsupported'
    and descriptor->>'compilerReferenceCoverage' = 'unavailable'
    and descriptor->'artifactBytesAuthenticated' = 'false'::jsonb
    and descriptor->>'connectionAuthorization' = 'not_minted'),false))
);
create table if not exists platform.mixed_child_intents (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  descriptor_digest text not null,
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  receipt jsonb check (octet_length(receipt::text) <= 16000),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id,child_operation_id),
  foreign key (workspace_id,parent_operation_id,child_operation_id,descriptor_digest)
    references platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,descriptor_digest),
  check (coalesce(((phase='prepared' and attempt_id is null and run_id is null and receipt is null and attempted_at is null and acknowledged_at is null)
    or (phase='attempted' and attempt_id is not null and attempted_at is not null and run_id is null and receipt is null and acknowledged_at is null)
    or (phase='acknowledged' and attempt_id is not null and attempted_at is not null and run_id is not null and receipt is not null and acknowledged_at is not null
      and receipt->>'format'='zenith.mixed-child-history.v1'
      and receipt->>'workspaceId'=workspace_id and receipt->>'parentOperationId'=parent_operation_id
      and receipt->>'childOperationId'=child_operation_id and receipt->>'descriptorDigest'=descriptor_digest
      and receipt->>'attemptId'=attempt_id and receipt->>'runId'=run_id)),false))
);
create or replace function platform.immutable_mixed_child_custody() returns trigger language plpgsql as $$
begin
  raise exception 'Mixed child custody is immutable' using errcode='23514';
end
$$;
drop trigger if exists immutable_mixed_child_custody on platform.mixed_child_custody;
create trigger immutable_mixed_child_custody before update or delete on platform.mixed_child_custody
for each row execute function platform.immutable_mixed_child_custody();
create or replace function platform.retain_mixed_child_intent() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Mixed child attempt tombstones cannot be deleted' using errcode='23514';
  end if;
  if (new.workspace_id,new.parent_operation_id,new.child_operation_id,new.descriptor_digest,new.created_at)
    is distinct from (old.workspace_id,old.parent_operation_id,old.child_operation_id,old.descriptor_digest,old.created_at)
    or (old.attempt_id is not null and (new.attempt_id,new.attempted_at) is distinct from (old.attempt_id,old.attempted_at))
    or (old.phase='acknowledged' and new is distinct from old)
    or not ((old.phase='attempted' and new.phase='acknowledged') or new is not distinct from old) then
    -- No supported parent effects/browser-review representation exists yet.
    -- Even direct service-role UPDATE cannot promote a prepared candidate.
    raise exception 'Mixed child start is unsupported or nonreplayable' using errcode='23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_mixed_child_intent on platform.mixed_child_intents;
create trigger retain_mixed_child_intent before update or delete on platform.mixed_child_intents
for each row execute function platform.retain_mixed_child_intent();
alter table platform.mixed_child_custody enable row level security;
alter table platform.mixed_child_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant usage on schema platform to service_role;
    revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from service_role;
    grant select,insert on table platform.mixed_child_custody to service_role;
    grant select,insert,update on table platform.mixed_child_intents to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (14, 'mixed_child_intents', '5d676658116c3e66b1238c24a72da4ddbd65f06f30c57cf5dc753bcc0a56961e')
on conflict (version) do nothing;

-- ============================ migration 15: cleanup_writer_barriers ============================

create table if not exists platform.cleanup_writer_epoch (
  singleton boolean primary key default true check (singleton),
  installed_at timestamptz not null default clock_timestamp()
);
insert into platform.cleanup_writer_epoch(singleton) values(true) on conflict do nothing;
-- Every scoped and unscoped writer takes this coordinator AFTER its existing row locks.
-- The exact environment holds are separate; unrelated scoped environments remain writable.
create table if not exists platform.cleanup_writer_scopes (
  workspace_id text primary key,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.cleanup_writer_holds (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null check (generation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  authority_digest text not null check (authority_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,project_id,environment_id),
  unique(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id)
);
create table if not exists platform.cleanup_writer_deliveries (
  workspace_id text not null,
  project_id text,
  environment_id text,
  operation_id text not null,
  family text not null check (family in ('workflow','plan','build','runner','machine','grant')),
  identity text not null,
  capability text not null,
  attempt_id text,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,family,identity)
);
create table if not exists platform.cleanup_owner_grants (
  workspace_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null,
  jti text not null unique,
  capability text not null check (capability='infrastructure.destroy'),
  audience text not null check (audience='worker'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id,attempt_id,generation)
    references platform.cleanup_writer_holds(workspace_id,operation_id,attempt_id,generation)
);
create or replace function platform.immutable_cleanup_writer_history() returns trigger language plpgsql as $$
begin
  raise exception 'Cleanup history cannot be changed or cleared' using errcode='23514';
end
$$;
drop trigger if exists immutable_cleanup_epoch on platform.cleanup_writer_epoch;
create trigger immutable_cleanup_epoch before update or delete on platform.cleanup_writer_epoch
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_scope on platform.cleanup_writer_scopes;
create trigger immutable_cleanup_scope before update or delete on platform.cleanup_writer_scopes
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_hold on platform.cleanup_writer_holds;
create trigger immutable_cleanup_hold before update or delete on platform.cleanup_writer_holds
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_delivery on platform.cleanup_writer_deliveries;
create trigger immutable_cleanup_delivery before update or delete on platform.cleanup_writer_deliveries
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_owner_grant on platform.cleanup_owner_grants;
create trigger immutable_cleanup_owner_grant before update or delete on platform.cleanup_owner_grants
for each row execute function platform.immutable_cleanup_writer_history();

create or replace function platform.cleanup_scope_epoch_unknown(ws text,proj text,env text) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,platform as $$
begin
  if to_regclass('public.environments') is null then return true; end if;
  return not exists(select 1 from public.environments e where e.workspace_id=ws and e.project_id=proj and e.id=env
    and e.created_at is not null and e.created_at >= (select installed_at from platform.cleanup_writer_epoch where singleton));
end
$$;
revoke all on function platform.cleanup_scope_epoch_unknown(text,text,text) from public;

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  select * into h from platform.cleanup_writer_holds where workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (project_id=o.project_id and environment_id=o.environment_id)) limit 1;
  if found then
    if family_name='grant' and delivery_cap='infrastructure.destroy' and new.audience='worker'
      and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
        on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
        where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
          and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
      and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
      and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
      and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
        and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
      delivery_attempt:=h.attempt_id;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;
drop trigger if exists cleanup_workflow_writer on platform.workflow_start_intents;
create trigger cleanup_workflow_writer before insert or update of phase on platform.workflow_start_intents
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_plan_writer on platform.plan_artifact_uses;
create trigger cleanup_plan_writer before insert or update of phase on platform.plan_artifact_uses
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_build_writer on platform.build_launches;
create trigger cleanup_build_writer before insert on platform.build_launches
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_runner_writer on platform.runner_jobs;
create trigger cleanup_runner_writer before insert or update of status on platform.runner_jobs
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_machine_writer on platform.machine_requests;
create trigger cleanup_machine_writer before insert or update of status on platform.machine_requests
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_grant_writer on platform.capability_grants;
create trigger cleanup_grant_writer before insert on platform.capability_grants
for each row execute function platform.cleanup_writer_transition();
revoke all on function platform.cleanup_writer_transition() from public;
revoke all on function platform.immutable_cleanup_writer_history() from public;
alter table platform.cleanup_writer_epoch enable row level security;
alter table platform.cleanup_writer_scopes enable row level security;
alter table platform.cleanup_writer_holds enable row level security;
alter table platform.cleanup_writer_deliveries enable row level security;
alter table platform.cleanup_owner_grants enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
    grant select on table platform.cleanup_writer_epoch to service_role;
    grant execute on function platform.cleanup_scope_epoch_unknown(text,text,text) to service_role;
    grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
    -- Row locking needs UPDATE privilege; the immutable trigger refuses actual UPDATE.
    grant update on table platform.cleanup_writer_scopes to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (15, 'cleanup_writer_barriers', '1630821507e71c2ec68d0918bd82b0333aabb4f4211654927cc07d7eb4a6c123')
on conflict (version) do nothing;

-- ============================ migration 16: cleanup_writer_settlements ============================

create table if not exists platform.standalone_plan_backends (
  target_digest text primary key check (target_digest ~ '^[a-f0-9]{64}$'),
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists standalone_plan_backends_scope on platform.standalone_plan_backends(workspace_id,project_id,environment_id);
create table if not exists platform.standalone_plan_settlements (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  raw_sha256 text not null check (raw_sha256 ~ '^[a-f0-9]{64}$'),
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  target_digest text not null check (target_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  settlement_digest text not null check (settlement_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv)=16),
  auth_tag text not null check (length(auth_tag)=24),
  ciphertext text not null check (length(ciphertext) between 1 and 16384),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id),
  foreign key(target_digest) references platform.standalone_plan_backends(target_digest)
);
create index if not exists standalone_plan_settlements_scope on platform.standalone_plan_settlements(workspace_id,project_id,environment_id);
drop trigger if exists immutable_standalone_plan_backend on platform.standalone_plan_backends;
create trigger immutable_standalone_plan_backend before update or delete on platform.standalone_plan_backends
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_standalone_plan_settlement on platform.standalone_plan_settlements;
create trigger immutable_standalone_plan_settlement before update or delete on platform.standalone_plan_settlements
for each row execute function platform.immutable_cleanup_writer_history();
alter table platform.standalone_plan_backends enable row level security;
alter table platform.standalone_plan_settlements enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
    grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (16, 'cleanup_writer_settlements', '30f73b35ae4bf2da289bd1a3ce403cc0bd409f383efb942a7aa095235333d711')
on conflict (version) do nothing;

-- ============================ migration 17: machine_runbooks ============================

create or replace function platform.immutable_runbook_rows() returns trigger language plpgsql as $$
begin
  raise exception 'Runbook versions, approvals and audit entries cannot be changed or removed' using errcode='23514';
end
$$;

create table if not exists platform.machine_runbook_versions (
  workspace_id text not null,
  runbook_id text not null check (runbook_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  version integer not null check (version >= 1),
  name text not null,
  definition jsonb not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  signature text not null check (length(signature) between 1 and 4096),
  signing_kid text not null,
  published_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, runbook_id, version)
);
drop trigger if exists immutable_runbook_versions on platform.machine_runbook_versions;
create trigger immutable_runbook_versions before update or delete on platform.machine_runbook_versions
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_approvals (
  id text primary key,
  workspace_id text not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  requested_by text not null,
  approver_id text not null check (approver_id <> requested_by),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists machine_runbook_approvals_binding on platform.machine_runbook_approvals(workspace_id, binding_digest, created_at desc);
drop trigger if exists immutable_runbook_approvals on platform.machine_runbook_approvals;
create trigger immutable_runbook_approvals before update or delete on platform.machine_runbook_approvals
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_schedules (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  spec jsonb not null,
  targets jsonb not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('pending_approval','active','paused','cancelled','completed')),
  next_due_at timestamptz,
  created_by text not null,
  creator jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version)
);
create index if not exists machine_runbook_schedules_due on platform.machine_runbook_schedules(next_due_at) where status = 'active';

create table if not exists platform.machine_runbook_runs (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  schedule_id text references platform.machine_runbook_schedules(id),
  due_at timestamptz,
  targets jsonb not null,
  max_parallel_targets integer not null check (max_parallel_targets between 1 and 5),
  status text not null check (status in ('pending_approval','approved','running','succeeded','failed','cancelled','expired','uncertain')),
  cancel_requested_at timestamptz,
  cancel_reason text,
  requested_by text not null,
  requester jsonb not null,
  deadline_at timestamptz not null,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version),
  check ((schedule_id is null) = (due_at is null))
);
create unique index if not exists machine_runbook_runs_slot on platform.machine_runbook_runs(schedule_id, due_at) where schedule_id is not null;
create index if not exists machine_runbook_runs_scope on platform.machine_runbook_runs(workspace_id, status, created_at desc);

create table if not exists platform.machine_runbook_run_steps (
  workspace_id text not null,
  run_id text not null references platform.machine_runbook_runs(id),
  target_index integer not null check (target_index >= 0),
  step_id text not null,
  operation_id text not null,
  status text not null check (status in ('started','succeeded','failed','uncertain','skipped')),
  error_code text,
  evidence_id text,
  started_at timestamptz not null,
  finished_at timestamptz,
  primary key (workspace_id, run_id, target_index, step_id)
);

create table if not exists platform.machine_runbook_audit (
  workspace_id text not null,
  subject text not null,
  seq integer not null check (seq >= 1),
  event text not null,
  actor text not null,
  detail jsonb not null,
  prev_digest text not null check (prev_digest ~ '^[a-f0-9]{64}$'),
  entry_digest text not null check (entry_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (workspace_id, subject, seq)
);
drop trigger if exists immutable_runbook_audit on platform.machine_runbook_audit;
create trigger immutable_runbook_audit before update or delete on platform.machine_runbook_audit
for each row execute function platform.immutable_runbook_rows();

alter table platform.machine_runbook_versions enable row level security;
alter table platform.machine_runbook_approvals enable row level security;
alter table platform.machine_runbook_schedules enable row level security;
alter table platform.machine_runbook_runs enable row level security;
alter table platform.machine_runbook_run_steps enable row level security;
alter table platform.machine_runbook_audit enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from service_role;
    grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
    grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (17, 'machine_runbooks', '757f57cf9d043b3f7bb2dcaa9af025c0a3251596a1ed5ddf9e6c21c6009518b9')
on conflict (version) do nothing;

-- ============================ migration 18: ownership_transfers ============================

create table if not exists platform.ownership_transfers (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  address          text        not null check (length(address) between 1 and 500),
  resource_type    text        not null check (length(resource_type) between 1 and 200),
  field_path       text        not null check (length(field_path) between 1 and 500),
  from_owner       text        not null check (from_owner in ('iac','native-op','autoscaler')),
  to_owner         text        not null check (to_owner in ('iac','native-op','autoscaler') and to_owner <> from_owner),
  transfer_digest  text        not null check (transfer_digest ~ '^[0-9a-f]{64}$'),
  operation_id     text        not null,
  approval_id      text        not null references platform.approvals(id),
  proposal_digest  text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  approved_at      timestamptz not null,
  expires_at       timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id, transfer_digest),
  check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists ownership_transfers_env_address on platform.ownership_transfers (workspace_id, environment_id, address) where revoked_at is null;
create or replace function platform.ownership_transfer_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Ownership transfers cannot be deleted' using errcode = '23514';
  end if;
  if old.revoked_at is not null
     or new.revoked_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.address, new.resource_type, new.field_path, new.from_owner,
         new.to_owner, new.transfer_digest, new.operation_id, new.approval_id, new.proposal_digest, new.approved_at, new.expires_at, new.created_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.address, old.resource_type, old.field_path, old.from_owner,
         old.to_owner, old.transfer_digest, old.operation_id, old.approval_id, old.proposal_digest, old.approved_at, old.expires_at, old.created_at)
  then
    raise exception 'Ownership transfers can only be revoked, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists ownership_transfer_guard on platform.ownership_transfers;
create trigger ownership_transfer_guard before update or delete on platform.ownership_transfers
for each row execute function platform.ownership_transfer_guard();
alter table platform.ownership_transfers enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.ownership_transfers from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.ownership_transfers from service_role;
    grant select,insert on table platform.ownership_transfers to service_role;
    grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (18, 'ownership_transfers', 'd19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a')
on conflict (version) do nothing;

-- ============================ migration 19: incident_stability ============================

alter table platform.incidents add column if not exists fingerprint text;
alter table platform.incidents add column if not exists occurrence_count integer not null default 1;
alter table platform.incidents add column if not exists last_seen_at timestamptz;
alter table platform.incidents add column if not exists escalated_at timestamptz;
alter table platform.incidents add column if not exists escalation_reasons jsonb not null default '[]'::jsonb;
alter table platform.incidents add column if not exists escalation_acknowledged_at timestamptz;
alter table platform.incidents add column if not exists escalation_acknowledged_by text;
create unique index if not exists incidents_open_fingerprint
  on platform.incidents (workspace_id, fingerprint)
  where fingerprint is not null and status <> 'resolved';

create table if not exists platform.incident_signal_state (
  workspace_id        text        not null,
  environment_id      text        not null,
  fingerprint         text        not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  state               text        not null default 'quiet' check (state in ('quiet','active')),
  consecutive_bad     integer     not null default 0 check (consecutive_bad >= 0),
  consecutive_good    integer     not null default 0 check (consecutive_good >= 0),
  last_observed_at    timestamptz not null,
  cooldown_until      timestamptz,
  updated_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, environment_id, fingerprint)
);

create table if not exists platform.incident_remediation_attempts (
  id               text        not null primary key,
  workspace_id     text        not null,
  incident_id      text        not null,
  environment_id   text        not null,
  fingerprint      text        not null,
  idempotency_key  text        not null check (idempotency_key ~ '^[a-f0-9]{64}$'),
  capability       text        not null,
  resource_id      text,
  blast_radius     text        not null check (blast_radius in ('low','medium','high')),
  status           text        not null check (status in ('reserved','succeeded','failed','abandoned','blocked')),
  block_codes      jsonb       not null default '[]'::jsonb,
  operation_id     text,
  reserved_at      timestamptz not null default clock_timestamp(),
  settled_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);
create unique index if not exists incident_attempts_key_live
  on platform.incident_remediation_attempts (workspace_id, incident_id, idempotency_key) where status <> 'blocked';
create index if not exists incident_attempts_incident on platform.incident_remediation_attempts (workspace_id, incident_id, reserved_at);
create index if not exists incident_attempts_env on platform.incident_remediation_attempts (workspace_id, environment_id, reserved_at);
create unique index if not exists incident_attempts_operation
  on platform.incident_remediation_attempts (workspace_id, operation_id) where operation_id is not null and status <> 'blocked';
create index if not exists incident_attempts_fp on platform.incident_remediation_attempts (workspace_id, fingerprint, reserved_at);

create table if not exists platform.incident_maintenance_windows (
  id              text        not null primary key,
  workspace_id    text        not null,
  environment_id  text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text        not null,
  created_by      text        not null,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '7 days')
);
create index if not exists incident_windows_ws on platform.incident_maintenance_windows (workspace_id, ends_at desc);

create table if not exists platform.incident_postmortems (
  id             text        not null primary key,
  workspace_id   text        not null,
  incident_id    text        not null,
  document       jsonb       not null,
  document_digest text       not null check (document_digest ~ '^[a-f0-9]{64}$'),
  created_at     timestamptz not null default clock_timestamp(),
  unique (workspace_id, incident_id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);

insert into platform.schema_migrations (version, name, checksum)
values (19, 'incident_stability', '1db1a588796af8f7c9c01f62ab96e43d8f56a0f7e98b436a68af7e22813f8340')
on conflict (version) do nothing;

-- ============================ migration 20: optimizer_settings ============================

create table if not exists platform.optimizer_settings (
  environment_id text primary key,
  workspace_id   text not null,
  enabled        boolean not null default false,
  version        integer not null default 1 check (version >= 1),
  updated_by     text not null,
  updated_at     timestamptz not null default clock_timestamp()
);
create index if not exists optimizer_settings_enabled on platform.optimizer_settings(workspace_id, environment_id) where enabled;
alter table platform.optimizer_settings enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.optimizer_settings from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.optimizer_settings from service_role;
    grant select,insert,update on table platform.optimizer_settings to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (20, 'optimizer_settings', '94217cb0c092fa1c268ba54b3fe10143382531dd74d9081c190030f26b67b249')
on conflict (version) do nothing;

-- ============================ migration 21: scheduled_job_runs ============================

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

insert into platform.schema_migrations (version, name, checksum)
values (21, 'scheduled_job_runs', '462b8688f2776cf278dc0376c4f161c7169a3bc34ee77f6ad066006502108ab4')
on conflict (version) do nothing;

-- ============================ migration 22: connection_rotations ============================

create table if not exists platform.connection_rotations (
  id                  text        not null primary key,
  workspace_id        text        not null,
  connection_id       text        not null,
  status              text        not null check (status in ('staged','verified','failed','promoted','aborted','superseded')),
  base_config_digest  text        not null check (base_config_digest ~ '^[0-9a-f]{64}$'),
  candidate_config    jsonb       not null,
  candidate_digest    text        not null check (candidate_digest ~ '^[0-9a-f]{64}$'),
  verification_detail text,
  verified_at         timestamptz,
  created_by          text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  resolved_by         text,
  resolved_at         timestamptz,
  foreign key (workspace_id, connection_id) references platform.provider_connections (workspace_id, id),
  check ((status in ('promoted','aborted','superseded')) = (resolved_at is not null))
);
create unique index if not exists connection_rotations_open on platform.connection_rotations (workspace_id, connection_id) where status in ('staged','verified','failed');
create index if not exists connection_rotations_ws on platform.connection_rotations (workspace_id, connection_id, created_at desc);
alter table platform.connection_rotations enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.connection_rotations from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.connection_rotations from service_role;
    grant select,insert,update on table platform.connection_rotations to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (22, 'connection_rotations', 'a2048eb9416e3207b9a6a4b863a2458dc2667ef9c64b2903c306ffaefa2df79b')
on conflict (version) do nothing;

-- ============================ migration 23: release_pipelines ============================

create table if not exists platform.release_runs (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  operation_id     text        not null,
  revision_id      text,
  requested_by     text        not null,
  service_address  text        not null check (length(service_address) between 1 and 500),
  kind             text        not null check (kind in ('deploy','rollback')),
  state            text        not null check (state in ('planned','built','verified','blocked_approval','deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified','failed','uncertain','rolled_back','refused')),
  image_uri        text        not null check (length(image_uri) between 1 and 500),
  image_digest     text        not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_digest    text,
  previous_digest  text        check (previous_digest is null or previous_digest ~ '^sha256:[0-9a-f]{64}$'),
  restores_run_id  text,
  provenance       jsonb       not null,
  migration        jsonb       not null,
  rollout          jsonb       not null,
  readback         jsonb,
  reason           text        check (reason is null or length(reason) <= 600),
  version          integer     not null default 1 check (version >= 1),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  unique (workspace_id, operation_id, service_address, kind),
  unique (workspace_id, id)
);
create index if not exists release_runs_env_service on platform.release_runs (workspace_id, environment_id, service_address, created_at desc);
create index if not exists release_runs_revision on platform.release_runs (workspace_id, environment_id, service_address, revision_id) where revision_id is not null;
create index if not exists release_runs_digest on platform.release_runs (workspace_id, environment_id, service_address, image_digest);

create table if not exists platform.release_events (
  workspace_id text        not null,
  run_id       text        not null,
  seq          integer     not null check (seq >= 1),
  from_state   text,
  to_state     text        not null,
  detail       text        not null check (length(detail) <= 600),
  actor        text        not null check (length(actor) <= 200),
  created_at   timestamptz not null default clock_timestamp(),
  primary key (workspace_id, run_id, seq),
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id)
);

create table if not exists platform.release_migration_approvals (
  id              text        not null primary key,
  workspace_id    text        not null,
  run_id          text        not null,
  binding_digest  text        not null check (binding_digest ~ '^[0-9a-f]{64}$'),
  class           text        not null check (class in ('data','contract','unclassified')),
  approved_by     text        not null,
  requested_by    text        not null,
  approved_at     timestamptz not null,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id),
  unique (workspace_id, run_id, binding_digest),
  check (approved_by <> requested_by),
  check (expires_at > approved_at)
);
create index if not exists release_migration_approvals_binding on platform.release_migration_approvals (workspace_id, binding_digest, approved_at desc);

create or replace function platform.release_run_guard() returns trigger language plpgsql as $$
declare allowed text[];
begin
  if tg_op = 'DELETE' then
    raise exception 'Release runs cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.project_id, new.environment_id, new.operation_id, new.revision_id, new.requested_by, new.service_address, new.kind,
      new.image_digest, new.source_digest, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.project_id, old.environment_id, old.operation_id, old.revision_id, old.requested_by, old.service_address, old.kind,
      old.image_digest, old.source_digest, old.created_at) then
    raise exception 'A release is bound to its image digest and identity; they cannot change' using errcode = '23514';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Release version must advance by one' using errcode = '23514';
  end if;
  allowed := case old.state
    when 'planned' then array['built','failed','uncertain','refused']
    when 'built' then array['verified','failed','uncertain','refused']
    when 'verified' then array['verified','blocked_approval','deployed','failed','uncertain','refused']
    when 'blocked_approval' then array['blocked_approval','verified','failed','uncertain','refused']
    when 'deployed' then array['deployed','migrated','rolled_back','failed','uncertain','refused']
    when 'migrated' then array['ready','rolled_back','failed','uncertain','refused']
    when 'ready' then array['cut_over','rolled_back','failed','uncertain','refused']
    when 'cut_over' then array['readback_verified','cut_over_unverified','rolled_back','failed','uncertain','refused']
    when 'readback_verified' then array['rolled_back']
    when 'cut_over_unverified' then array['rolled_back']
    when 'uncertain' then array['rolled_back','failed']
    else array[]::text[]
  end;
  if not (new.state = any(allowed)) then
    raise exception 'A release cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  if new.state in ('deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified')
     and (new.provenance->>'level' is null or new.provenance->>'level' = 'none') then
    raise exception 'A release cannot be deployed without verified provenance' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_run_guard on platform.release_runs;
create trigger release_run_guard before update or delete on platform.release_runs
for each row execute function platform.release_run_guard();

create or replace function platform.release_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Release events are append-only' using errcode = '23514';
end
$$;
drop trigger if exists release_events_append_only on platform.release_events;
create trigger release_events_append_only before update or delete on platform.release_events
for each row execute function platform.release_append_only();

create or replace function platform.release_approval_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Migration approvals cannot be deleted' using errcode = '23514';
  end if;
  if old.consumed_at is not null
     or new.consumed_at is null
     or (new.id, new.workspace_id, new.run_id, new.binding_digest, new.class, new.approved_by, new.requested_by, new.approved_at, new.expires_at)
        is distinct from
        (old.id, old.workspace_id, old.run_id, old.binding_digest, old.class, old.approved_by, old.requested_by, old.approved_at, old.expires_at) then
    raise exception 'A migration approval can only be consumed, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_approval_guard on platform.release_migration_approvals;
create trigger release_approval_guard before update or delete on platform.release_migration_approvals
for each row execute function platform.release_approval_guard();

alter table platform.release_runs enable row level security;
alter table platform.release_events enable row level security;
alter table platform.release_migration_approvals enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from service_role;
    grant select,insert,update on table platform.release_runs to service_role;
    grant select,insert on table platform.release_events to service_role;
    grant select,insert on table platform.release_migration_approvals to service_role;
    grant update (consumed_at) on table platform.release_migration_approvals to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (23, 'release_pipelines', '6b29a1332678cf2d72942d72994d9a4faf34e5c8cb633cb09307a17daf0fb1f6')
on conflict (version) do nothing;

-- ============================ migration 24: portability ============================

create table if not exists platform.portability_exports (
  id                text        not null primary key,
  workspace_id      text        not null,
  project_id        text,
  environment_id    text        not null,
  operation_id      text        not null,
  resource_id       text        not null,
  address           text        not null check (length(address) between 1 and 500),
  kind              text        not null check (kind in ('postgres','mysql','object_store')),
  provider          text        not null check (length(provider) between 1 and 60),
  engine            text        not null check (length(engine) between 1 and 60),
  engine_version    text        check (engine_version is null or length(engine_version) <= 200),
  destination_label text        not null check (length(destination_label) between 1 and 300),
  artifact_prefix   text        not null check (length(artifact_prefix) between 1 and 500),
  manifest_digest   text        not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  content_digest    text        not null check (content_digest ~ '^[0-9a-f]{64}$'),
  file_count        integer     not null check (file_count >= 0),
  byte_size         bigint      not null check (byte_size >= 0),
  coverage          jsonb       not null default '{}'::jsonb,
  verified_at       timestamptz not null,
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  unique (workspace_id, id)
);
create index if not exists portability_exports_env on platform.portability_exports (workspace_id, environment_id, created_at desc);

create table if not exists platform.portability_restores (
  id                      text        not null primary key,
  workspace_id            text        not null,
  project_id              text,
  environment_id          text        not null,
  operation_id            text        not null,
  export_id               text        not null,
  target_resource_id      text        not null,
  target_address          text        not null check (length(target_address) between 1 and 500),
  kind                    text        not null check (kind in ('postgres','mysql','object_store')),
  provider                text        not null check (length(provider) between 1 and 60),
  status                  text        not null check (status in ('verified','mismatch')),
  expected_content_digest text        not null check (expected_content_digest ~ '^[0-9a-f]{64}$'),
  observed_content_digest text        not null check (observed_content_digest ~ '^[0-9a-f]{64}$'),
  readback                jsonb       not null default '{}'::jsonb,
  restored                jsonb       not null default '{}'::jsonb,
  verified_at             timestamptz not null,
  created_at              timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, export_id) references platform.portability_exports (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'verified') = (expected_content_digest = observed_content_digest))
);
create index if not exists portability_restores_env on platform.portability_restores (workspace_id, environment_id, created_at desc);

create table if not exists platform.resource_adoptions (
  id                   text        not null primary key,
  workspace_id         text        not null,
  project_id           text,
  environment_id       text        not null,
  resource_id          text        not null,
  address              text        not null check (length(address) between 1 and 500),
  provider             text        not null check (length(provider) between 1 and 60),
  native_type          text        not null check (length(native_type) between 1 and 200),
  external_id          text        not null check (length(external_id) between 1 and 500),
  lifecycle            text        not null check (lifecycle in ('manage','manage_and_destroy')),
  claim                jsonb       not null,
  claim_digest         text        not null check (claim_digest ~ '^[0-9a-f]{64}$'),
  field_owners         jsonb       not null default '[]'::jsonb,
  baseline             jsonb       not null,
  baseline_digest      text        not null check (baseline_digest ~ '^[0-9a-f]{64}$'),
  operation_id         text        not null,
  approval_id          text        not null references platform.approvals(id),
  proposal_digest      text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  status               text        not null default 'active' check (status in ('active','released')),
  adopted_at           timestamptz not null default clock_timestamp(),
  released_at          timestamptz,
  released_by          text,
  release_operation_id text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'active') = (released_at is null)),
  check ((released_at is null) = (released_by is null))
);
create unique index if not exists resource_adoptions_active_object on platform.resource_adoptions (workspace_id, provider, native_type, external_id) where status = 'active';
create unique index if not exists resource_adoptions_active_address on platform.resource_adoptions (workspace_id, environment_id, address) where status = 'active';
create index if not exists resource_adoptions_env on platform.resource_adoptions (workspace_id, environment_id, adopted_at desc);

create or replace function platform.portability_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Portability records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists portability_exports_immutable on platform.portability_exports;
create trigger portability_exports_immutable before update or delete on platform.portability_exports
for each row execute function platform.portability_immutable();
drop trigger if exists portability_restores_immutable on platform.portability_restores;
create trigger portability_restores_immutable before update or delete on platform.portability_restores
for each row execute function platform.portability_immutable();

create or replace function platform.resource_adoption_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Adoption claims cannot be deleted' using errcode = '23514';
  end if;
  if old.status <> 'active'
     or new.status <> 'released'
     or new.released_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.resource_id, new.address, new.provider, new.native_type, new.external_id, new.lifecycle,
         new.claim, new.claim_digest, new.field_owners, new.baseline, new.baseline_digest, new.operation_id, new.approval_id, new.proposal_digest, new.adopted_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.resource_id, old.address, old.provider, old.native_type, old.external_id, old.lifecycle,
         old.claim, old.claim_digest, old.field_owners, old.baseline, old.baseline_digest, old.operation_id, old.approval_id, old.proposal_digest, old.adopted_at)
  then
    raise exception 'Adoption claims can only be released, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists resource_adoption_guard on platform.resource_adoptions;
create trigger resource_adoption_guard before update or delete on platform.resource_adoptions
for each row execute function platform.resource_adoption_guard();

alter table platform.portability_exports enable row level security;
alter table platform.portability_restores enable row level security;
alter table platform.resource_adoptions enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['portability_exports','portability_restores','resource_adoptions'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
      execute format('grant select,insert on table platform.%I to service_role', t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant update (status, released_at, released_by, release_operation_id) on table platform.resource_adoptions to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (24, 'portability', '9ae6f39475d3abb1317d44544ec0c8d6920e74f19c0b5af813339a5b41b11f20')
on conflict (version) do nothing;

-- ============================ migration 25: agent_lifecycle ============================

alter table platform.runners
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
alter table platform.machines
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runners_lifecycle_bounded') then
    alter table platform.runners add constraint runners_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'machines_lifecycle_bounded') then
    alter table platform.machines add constraint machines_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (25, 'agent_lifecycle', '372c684b5da9f326f8852a3de713914a16b1a1849cb332967a6fb422f78e2fdd')
on conflict (version) do nothing;

-- ============================ migration 26: plugin_boundaries ============================

create table if not exists platform.plugin_registrations (
  id              text primary key,
  workspace_id    text not null,
  plugin_id       text not null,
  plugin_version  text not null,
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text not null check (artifact_digest ~ '^[0-9a-f]{64}$'),
  publisher_id    text not null,
  manifest        jsonb not null,
  provenance      jsonb not null,
  status          text not null check (status in ('pending_review','approved','rejected','revoked')),
  approved_tools  jsonb not null default '[]'::jsonb,
  approved_scopes jsonb not null default '[]'::jsonb,
  requested_by    text not null,
  reviewed_by     text,
  reviewed_at     timestamptz,
  revoked_by      text,
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, plugin_id, plugin_version)
);
create index if not exists plugin_registrations_ws on platform.plugin_registrations(workspace_id, created_at desc);
create table if not exists platform.plugin_grants (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null references platform.plugin_registrations(id),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  audience        text not null,
  credential_id   text not null,
  subject         text not null,
  scopes          jsonb not null,
  project_ids     jsonb not null,
  environment_ids jsonb,
  created_by      text not null,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_used_at    timestamptz
);
create index if not exists plugin_grants_registration on platform.plugin_grants(workspace_id, registration_id);
create table if not exists platform.plugin_events (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null,
  kind            text not null,
  actor           text not null,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists plugin_events_registration on platform.plugin_events(workspace_id, registration_id, created_at);
alter table platform.plugin_registrations enable row level security;
alter table platform.plugin_grants enable row level security;
alter table platform.plugin_events enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['plugin_registrations','plugin_grants','plugin_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      if t = 'plugin_events' then
        execute format('grant select,insert on table platform.%I to service_role',t);
      else
        execute format('grant select,insert,update on table platform.%I to service_role',t);
      end if;
    end if;
  end loop;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (26, 'plugin_boundaries', '730dd0df2e58ff3f1e255ade7651cfac75879d84752f620d2785dff359c98c3a')
on conflict (version) do nothing;

-- ============================ migration 27: github_revocation_reason ============================

alter table platform.github_source_bindings add column if not exists revoked_reason text
  check (revoked_reason is null or revoked_reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));
alter table platform.github_binding_events add column if not exists reason text
  check (reason is null or reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));

insert into platform.schema_migrations (version, name, checksum)
values (27, 'github_revocation_reason', '5af4252a6e4d0a65fe712b50b9d1da0f418ba3176c4c6f3ba0314bac7bd90b12')
on conflict (version) do nothing;

-- ============================ migration 28: incident_stability_hardening ============================

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

insert into platform.schema_migrations (version, name, checksum)
values (28, 'incident_stability_hardening', '53fc08fb199fb67385b19a5bc251ca178c55026f50cb2c4a3db21ce44a5880b8')
on conflict (version) do nothing;

-- ============================ migration 29: cleanup_writer_record_fields ============================

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  select * into h from platform.cleanup_writer_holds where workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (project_id=o.project_id and environment_id=o.environment_id)) limit 1;
  if found then
    if family_name='grant' then
      if delivery_cap='infrastructure.destroy' and new.audience='worker'
        and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
          on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
          where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
            and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
        and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
        and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
        and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
          and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
        delivery_attempt:=h.attempt_id;
      else
        raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
      end if;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (29, 'cleanup_writer_record_fields', 'e9cd8aaa47d4909c53f8ff5e71690cc6a07d85dae60de69d35192d97e5e7e0dc')
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
    -- Permanent agent receipts keep their narrower migration-specific grants.
    -- Guard absence for the exact legacy schema6 upgrade fixture.
    if to_regclass('platform.agent_effect_receipts') is not null then
      revoke update, delete on table platform.agent_effect_receipts from service_role;
    end if;
    -- Workflow-start attempt tombstones must survive aggregate hardening.
    -- Exact rights also remove inherited TRUNCATE, REFERENCES and TRIGGER.
    if to_regclass('platform.workflow_start_intents') is not null then
      revoke all on table platform.workflow_start_intents from service_role;
      grant select, insert, update on table platform.workflow_start_intents to service_role;
    end if;
    -- Approved source authority is immutable, including inherited privileges.
    if to_regclass('platform.approved_source_snapshots') is not null then
      revoke all on table platform.approved_source_snapshots from service_role;
      grant select, insert on table platform.approved_source_snapshots to service_role;
    end if;
    -- Mixed child candidates never inherit DELETE/TRUNCATE or writable descriptor grants.
    if to_regclass('platform.mixed_child_custody') is not null then
      revoke all on table platform.mixed_child_custody from service_role;
      grant select, insert on table platform.mixed_child_custody to service_role;
    end if;
    if to_regclass('platform.mixed_child_intents') is not null then
      revoke all on table platform.mixed_child_intents from service_role;
      grant select, insert, update on table platform.mixed_child_intents to service_role;
    end if;
    if to_regclass('platform.cleanup_writer_epoch') is not null then
      revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
      grant select on table platform.cleanup_writer_epoch to service_role;
      grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
      grant update on table platform.cleanup_writer_scopes to service_role;
    end if;
    -- Ownership transfers are append-only: select/insert plus one-way revocation columns.
    if to_regclass('platform.ownership_transfers') is not null then
      revoke all on table platform.ownership_transfers from service_role;
      grant select, insert on table platform.ownership_transfers to service_role;
      grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
    end if;
    if to_regclass('platform.optimizer_settings') is not null then
      revoke all on table platform.optimizer_settings from service_role;
      grant select,insert,update on table platform.optimizer_settings to service_role;
    end if;
    if to_regclass('platform.standalone_plan_settlements') is not null then
      revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
      grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
    end if;
    if to_regclass('platform.machine_runbook_versions') is not null then
      revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps from service_role;
      grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
      grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
    end if;
  end if;
end
$$;
