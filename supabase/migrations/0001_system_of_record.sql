-- Zenith system of record — Supabase Postgres schema (Phase 2).
--
-- Shape, uniformly:
--   id          text        the domain id, exactly as the file store mints it
--   workspace_id text       the tenant; present on every row, including rows whose
--                           TypeScript type derives it through its project
--   <promoted>              only the columns a real query filters or sorts on
--   data        jsonb       everything else, verbatim, so hydration is
--                           `{ ...row.data, ...promotedColumns }` and the object is
--                           byte-identical to what FileStore hands back
--   version     bigint      optimistic concurrency; every write is guarded on it
--   updated_at  timestamptz
--
-- Idempotent on purpose: `create table if not exists` / `create index if not exists`
-- throughout, so re-applying it is a no-op.
--
-- Row level security is ON for every table and NO policies are defined. That is
-- deliberate: the service role bypasses RLS, and it is the only identity that
-- ever reaches these tables (the server holds SUPABASE_SERVICE_ROLE_KEY; the
-- browser never talks to PostgREST for product A). Anon and authenticated roles
-- therefore see nothing at all, which is the correct default for a store whose
-- tenancy is enforced in application code.
--
-- Deviations from the approved design are marked `-- DEVIATION:` below.

/* ------------------------------- workspaces ------------------------------- */

create table if not exists public.workspaces (
  id           text primary key,
  workspace_id text not null,
  slug         text not null,
  name         text not null,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

create unique index if not exists workspaces_slug_key on public.workspaces (slug);

/* --------------------------------- members -------------------------------- */

-- Composite primary key: a member id is a Supabase auth user id, and the same
-- person can hold a row in more than one workspace.
create table if not exists public.members (
  id           text not null,
  workspace_id text not null,
  email        text not null default '',
  role         text not null,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);

-- Membership is resolved by lower(email) on every request (server/workspace.ts
-- `workspacesFor`, server/membership.ts `joinTarget`).
create index if not exists members_email_lower_idx on public.members (lower(email));
create index if not exists members_workspace_idx on public.members (workspace_id);

/* --------------------------------- invites -------------------------------- */

-- DEVIATION (recorded, not resolved here): in the file store invites live inside
-- the install-global `settings` bag (`settings.invites`, see
-- src/lib/server/membership.ts). They get a real table because they are the one
-- thing in that bag that is genuinely per-workspace and is looked up by a
-- promoted column on the sign-in path. The postgres store projects this table
-- back into `settings.invites` on hydration so no caller changes.
create table if not exists public.invites (
  id           text primary key,
  workspace_id text not null,
  email        text not null,
  role         text not null,
  accepted_at  timestamptz,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

-- Only pending invites are ever searched by address.
create index if not exists invites_pending_email_idx
  on public.invites (lower(email))
  where accepted_at is null;
create index if not exists invites_workspace_idx on public.invites (workspace_id);

/* ------------------------------- connections ------------------------------ */

create table if not exists public.connections (
  id           text primary key,
  workspace_id text not null,
  provider     text not null,
  status       text not null,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

create index if not exists connections_workspace_idx on public.connections (workspace_id);

/* -------------------------------- projects -------------------------------- */

-- `workingManifest` stays in `data`: it is the editable working copy, it is read
-- on every project screen, and splitting it out would buy a join for nothing.
create table if not exists public.projects (
  id           text primary key,
  workspace_id text not null,
  slug         text not null,
  name         text not null,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

-- Slugs are unique per workspace, never globally — server/scope.ts
-- `scopedProject` resolves (slug, workspace) precisely because of this.
create unique index if not exists projects_workspace_slug_key
  on public.projects (workspace_id, slug);
create index if not exists projects_workspace_idx on public.projects (workspace_id);

/* ------------------------------ environments ------------------------------ */

create table if not exists public.environments (
  id                   text primary key,
  workspace_id         text not null,
  project_id           text not null references public.projects (id) on delete cascade,
  class                text not null,
  connection_id        text,
  deployed_revision_id text,
  active_deployment_id text,
  created_at           timestamptz,
  data                 jsonb not null default '{}',
  version              bigint not null default 1,
  updated_at           timestamptz not null default now()
);

create index if not exists environments_project_idx on public.environments (project_id);
create index if not exists environments_workspace_idx on public.environments (workspace_id);

/* -------------------------------- revisions ------------------------------- */

create table if not exists public.revisions (
  id           text primary key,
  workspace_id text not null,
  project_id   text not null,
  number       integer not null,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

-- Revision numbers are monotonic per project, and the next one is minted by
-- reading the highest: the constraint is what makes two concurrent deploys
-- fail loudly instead of both claiming the same number.
create unique index if not exists revisions_project_number_key
  on public.revisions (project_id, number);
create index if not exists revisions_workspace_idx on public.revisions (workspace_id);

-- Cold storage, one row per revision. Kept out of `revisions` so listing a
-- project's history never drags every manifest across the wire — the same
-- hot/cold split the file store makes with `<ZENITH_DATA>/revisions/`.
create table if not exists public.revision_manifests (
  revision_id  text primary key references public.revisions (id) on delete cascade,
  workspace_id text not null,
  manifest     jsonb not null,
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

create index if not exists revision_manifests_workspace_idx
  on public.revision_manifests (workspace_id);

/* ------------------------------- deployments ------------------------------ */

create table if not exists public.deployments (
  id             text primary key,
  workspace_id   text not null,
  project_id     text not null,
  environment_id text not null,
  revision_id    text not null,
  status         text not null,
  created_at     timestamptz,
  ended_at       timestamptz,
  data           jsonb not null default '{}',
  version        bigint not null default 1,
  updated_at     timestamptz not null default now()
);

-- q.deploymentsOf(environmentId) reads newest-first, always.
create index if not exists deployments_environment_created_idx
  on public.deployments (environment_id, created_at desc);
create index if not exists deployments_project_idx on public.deployments (project_id);

-- Resuming in-flight work after a restart scans exactly these statuses.
create index if not exists deployments_in_flight_idx
  on public.deployments (workspace_id)
  where status in ('planning', 'awaiting_approval', 'applying', 'verifying', 'rolling_back');

/* -------------------------------- findings -------------------------------- */

create table if not exists public.findings (
  id             text primary key,
  workspace_id   text not null,
  project_id     text not null,
  environment_id text,
  status         text not null,
  severity       text not null,
  created_at     timestamptz,
  data           jsonb not null default '{}',
  version        bigint not null default 1,
  updated_at     timestamptz not null default now()
);

create index if not exists findings_project_idx on public.findings (project_id);
create index if not exists findings_workspace_idx on public.findings (workspace_id);

/* ------------------------------ navigator runs ---------------------------- */

create table if not exists public.navigator_runs (
  id           text primary key,
  workspace_id text not null,
  project_id   text not null,
  status       text not null,
  created_at   timestamptz,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

create index if not exists navigator_runs_project_idx on public.navigator_runs (project_id);
create index if not exists navigator_runs_workspace_idx on public.navigator_runs (workspace_id);

/* --------------------------------- alerts --------------------------------- */

create table if not exists public.alert_rules (
  id             text primary key,
  workspace_id   text not null,
  project_id     text not null,
  environment_id text not null,
  kind           text not null,
  enabled        boolean not null default true,
  data           jsonb not null default '{}',
  version        bigint not null default 1,
  updated_at     timestamptz not null default now()
);

-- One standing rule per (environment, kind); the domain says so, so the
-- database says so too.
create unique index if not exists alert_rules_environment_kind_key
  on public.alert_rules (environment_id, kind);
create index if not exists alert_rules_workspace_idx on public.alert_rules (workspace_id);

create table if not exists public.alert_events (
  id             text primary key,
  workspace_id   text not null,
  rule_id        text not null,
  project_id     text not null,
  environment_id text not null,
  fired_at       timestamptz,
  resolved_at    timestamptz,
  data           jsonb not null default '{}',
  version        bigint not null default 1,
  updated_at     timestamptz not null default now()
);

-- At most one open event per rule; finding it is the evaluator's hot path.
create index if not exists alert_events_open_rule_idx
  on public.alert_events (rule_id)
  where resolved_at is null;
create index if not exists alert_events_workspace_idx on public.alert_events (workspace_id);

create table if not exists public.alert_outbox (
  id              text primary key,
  workspace_id    text not null,
  channel_id      text not null,
  event_id        text not null,
  status          text not null,
  claimed_at      timestamptz,
  attempts        integer not null default 0,
  idempotency_key text not null,
  data            jsonb not null default '{}',
  version         bigint not null default 1,
  updated_at      timestamptz not null default now()
);

-- Stable across retries of the same transition on the same channel: the unique
-- index is what makes a duplicate send impossible rather than merely unlikely.
create unique index if not exists alert_outbox_idempotency_key
  on public.alert_outbox (idempotency_key);

-- The drainer claims work from exactly this window, and reclaims stale claims
-- by `claimed_at`.
create index if not exists alert_outbox_claimable_idx
  on public.alert_outbox (status, claimed_at)
  where status in ('pending', 'sending');

/* -------------------------------- settings -------------------------------- */

-- DEVIATION: `Database.settings` is install-global, not per-workspace —
-- `autonomy` is a single dial and `alertChannels` is a flat list carrying its
-- own workspaceId (src/lib/db/types.ts says so at length). The table keeps the
-- designed per-workspace primary key, and the install-global bag lives in the
-- single reserved row `workspace_id = '__install__'`, loaded and written whole.
-- Per-workspace rows are available for the phase that splits the bag up.
create table if not exists public.settings (
  workspace_id text primary key,
  data         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now()
);

/* --------------------------- deployment events ---------------------------- */

-- Append-only. `seq` is per deployment and dense, so the SSE tail is a single
-- range scan on the primary key.
create table if not exists public.deployment_events (
  deployment_id text not null,
  seq           integer not null,
  workspace_id  text not null,
  ts            timestamptz,
  body          jsonb not null,
  primary key (deployment_id, seq)
);

create index if not exists deployment_events_workspace_idx
  on public.deployment_events (workspace_id);

/* ------------------------------ audit events ------------------------------ */

-- `seq` is the database's own ordering, not the domain's: audit rows carry a
-- timestamp but no sequence, and paging a log by timestamp alone cannot be
-- stable. The cursor `readAuditPage` hands out is this number.
create table if not exists public.audit_events (
  seq            bigserial primary key,
  id             text not null,
  workspace_id   text not null,
  ts             timestamptz not null,
  project_id     text,
  environment_id text,
  actor_type     text,
  action_id      text not null,
  result         text not null,
  data           jsonb not null default '{}'
);

create unique index if not exists audit_events_id_key on public.audit_events (id);

-- The activity screen: newest first within a workspace.
create index if not exists audit_events_workspace_seq_idx
  on public.audit_events (workspace_id, seq desc);

-- "what happened to this project, by action" — the filtered view.
create index if not exists audit_events_workspace_project_action_seq_idx
  on public.audit_events (workspace_id, project_id, action_id, seq desc);

/* --------------------------------- secrets -------------------------------- */

-- DEVIATION: the file store holds one combined string per row —
-- `base64(iv).base64(authTag).base64(ciphertext)` (src/lib/secrets/index.ts,
-- `StoredSecret.cipher`). The three parts are a fixed, lossless split of that
-- string, so the columns below are kept as designed and the Phase 3 store
-- joins/splits on the boundary. `meta` carries createdAt/createdBy/updatedAt/
-- updatedBy; `version` doubles as the domain's rotation counter.
create table if not exists public.secrets (
  workspace_id text not null,
  ref          text not null,
  iv           text not null,
  auth_tag     text not null,
  ciphertext   text not null,
  key_version  integer not null default 1,
  meta         jsonb not null default '{}',
  version      bigint not null default 1,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, ref)
);

/* ---------------------------- workspace versions --------------------------- */

-- The change feed. `onChange` cannot be an in-process EventEmitter once more
-- than one instance serves the app, so every flush bumps the row for the
-- workspace it touched and records which projects moved; listeners poll this
-- one narrow table (300 ms, the SSE tick) instead of the whole store.
create table if not exists public.workspace_versions (
  workspace_id      text primary key,
  version           bigint not null default 1,
  touched_projects  jsonb not null default '[]',
  updated_at        timestamptz not null default now()
);

/* ----------------------------- row level security -------------------------- */

-- Enabled everywhere, with no policies: service role only. See the header.
alter table public.workspaces          enable row level security;
alter table public.members             enable row level security;
alter table public.invites             enable row level security;
alter table public.connections         enable row level security;
alter table public.projects            enable row level security;
alter table public.environments        enable row level security;
alter table public.revisions           enable row level security;
alter table public.revision_manifests  enable row level security;
alter table public.deployments         enable row level security;
alter table public.findings            enable row level security;
alter table public.navigator_runs      enable row level security;
alter table public.alert_rules         enable row level security;
alter table public.alert_events        enable row level security;
alter table public.alert_outbox        enable row level security;
alter table public.settings            enable row level security;
alter table public.deployment_events   enable row level security;
alter table public.audit_events        enable row level security;
alter table public.secrets             enable row level security;
alter table public.workspace_versions  enable row level security;

/* --------------------------------- grants --------------------------------- */

-- Service role is the only identity that reads or writes these tables. A table
-- created by the postgres owner carries no privileges for other roles, so the
-- grants are explicit; anon and authenticated deliberately receive none (RLS is
-- on with no policies, so even a grant would show them nothing).
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select, update on sequences to service_role;
