-- Zenith hosted control authority — Supabase Postgres schema (Phase 3).
--
-- This is `src/lib/hosted/authority/schema.ts` (MIGRATIONS v1 + v2, as they
-- stand after v2 rebuilt `invite_deliveries`) translated literally into a
-- `hosted` schema in Postgres. Same tables, same columns, same CHECKs, same
-- foreign keys, same partial unique indexes. Nothing was added, nothing was
-- relaxed: the database is what refuses a state the admission code has no
-- branch for, and that has to stay true on both stores.
--
-- Translation rules, applied uniformly:
--
--   TEXT                  -> text
--   INTEGER               -> integer, or bigint for counters that only grow
--                            (fence tokens, byte sizes, sequence numbers)
--   REAL                  -> double precision
--   BLOB                  -> bytea
--   INTEGER CHECK (x IN (0,1))
--                         -> boolean, where the column is a flag
--                            (`hosted_events.assisted` is the only one)
--   INTEGER PRIMARY KEY AUTOINCREMENT
--                         -> bigint generated always as identity primary key
--   length(x) = 64        -> char_length(x) = 64
--   day GLOB '[0-9]…'     -> day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
--
-- **Timestamps stay `text`, on purpose.** Every timestamp this authority
-- stores is `Date#toISOString()` — fixed width `YYYY-MM-DDTHH:MM:SS.sssZ` — so
-- lexicographic comparison *is* chronological comparison, and `expires_at > $1`
-- / `lease_until <= $1` are plain string predicates on both stores. A
-- `timestamptz` column here would change the ordering semantics of the lease
-- and expiry predicates the gateway admits requests with, and would make the
-- two implementations disagree about a boundary. See `authority/sql.ts`.
--
-- Idempotent throughout (`create schema if not exists`, `create table if not
-- exists`, `create index if not exists`, `on conflict do nothing` for the
-- seed), so re-applying it is a no-op. Applied by hand by the operator.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that ever reaches these tables. Anon
-- and authenticated see nothing at all.

create schema if not exists hosted;

/* ---------------------------- schema_migrations ---------------------------- */

-- The same ledger `schema.ts` keeps on SQLite. The Postgres authority does not
-- apply migrations — this file is applied by hand — it *reads* this table at
-- boot and refuses to start if the newest version in MIGRATIONS is missing.
create table if not exists hosted.schema_migrations (
  version    integer not null primary key,
  name       text    not null,
  applied_at text    not null
);

/* --------------------------------- apps ----------------------------------- */

create table if not exists hosted.apps (
  id                text    not null primary key,
  workspace_id      text    not null,
  slug              text    not null unique,
  name              text    not null,
  contract_version  integer not null check (contract_version = 1),
  schema_version    integer not null check (schema_version = 1),
  state             text    not null check (state in ('active','suspended','recovering','deleted')),
  state_reason      text,
  created_by        text    not null,
  created_at        text    not null,
  updated_at        text    not null,
  -- The foreign key to hosted.releases is added after that table exists: the
  -- two reference each other, and Postgres — unlike SQLite — resolves a REFERENCES
  -- clause at create time.
  active_release_id text,
  active_fence      bigint  not null default 0 check (active_fence >= 0),
  runtime           text    not null check (runtime in ('local','cloudflare'))
);
create index if not exists apps_workspace on hosted.apps (workspace_id);

/* ------------------------------- app_grants -------------------------------- */

create table if not exists hosted.app_grants (
  id             text not null primary key,
  app_id         text not null references hosted.apps(id),
  subject        text not null,
  email          text not null,
  role           text not null check (role in ('owner','editor','viewer')),
  state          text not null check (state in ('active','revoked','needs_reapproval')),
  granted_by     text not null,
  created_at     text not null,
  updated_at     text not null,
  revoked_at     text,
  revoked_by     text,
  revoked_reason text,
  check ((state = 'revoked') = (revoked_at is not null))
);
-- One live grant per (app, subject). Revoked and needs_reapproval rows stay as
-- history, which is why the uniqueness is partial rather than on the pair.
create unique index if not exists app_grants_active on hosted.app_grants (app_id, subject) where state = 'active';
create index if not exists app_grants_app on hosted.app_grants (app_id);
create index if not exists app_grants_subject on hosted.app_grants (subject);

/* ------------------------------- app_invites ------------------------------- */

create table if not exists hosted.app_invites (
  id          text not null primary key,
  app_id      text not null references hosted.apps(id),
  email       text not null,
  role        text not null check (role in ('owner','editor','viewer')),
  token_hash  text not null unique check (char_length(token_hash) = 64),
  state       text not null check (state in ('pending','accepted','expired','revoked','superseded')),
  created_by  text not null,
  created_at  text not null,
  expires_at  text not null,
  accepted_at text,
  accepted_by text,
  supersedes  text references hosted.app_invites(id),
  check ((state = 'accepted') = (accepted_at is not null))
);
create index if not exists app_invites_app on hosted.app_invites (app_id);
create index if not exists app_invites_email on hosted.app_invites (email);

/* ---------------------------- invite_deliveries ---------------------------- */

-- Already at v2: `transport = 'none'` is legal (no email transport configured,
-- the owner shares the link by hand). SQLite had to rebuild the table to widen
-- the CHECK; a fresh Postgres database simply starts with the widened one.
create table if not exists hosted.invite_deliveries (
  id                  text    not null primary key,
  invite_id           text    not null references hosted.app_invites(id),
  state               text    not null check (state in ('pending','sending','sent','failed')),
  attempts            integer not null default 0 check (attempts >= 0),
  created_at          text    not null,
  claimed_at          text,
  settled_at          text,
  transport           text    check (transport is null or transport in ('smtp','log','none')),
  provider_message_id text,
  error               text,
  -- The AES-GCM sealed invitation token W5 needs to rebuild the email on a
  -- retry. Opaque bytes here: this module never holds the key and never looks
  -- inside. Erased by clearSealedPayload() once the row settles.
  sealed_payload      bytea
);
create index if not exists invite_deliveries_invite on hosted.invite_deliveries (invite_id);
create index if not exists invite_deliveries_state on hosted.invite_deliveries (state, created_at);

/* ------------------------------ app_sessions ------------------------------- */

create table if not exists hosted.app_sessions (
  id                text not null primary key check (char_length(id) = 64),
  app_id            text not null references hosted.apps(id),
  subject           text not null,
  grant_id          text not null references hosted.app_grants(id),
  created_at        text not null,
  expires_at        text not null,
  terminated_at     text,
  terminated_reason text check (terminated_reason is null or terminated_reason in ('signed_out','revoked','expired','restored','operator')),
  check ((terminated_at is null) = (terminated_reason is null))
);
create index if not exists app_sessions_subject on hosted.app_sessions (subject);
create index if not exists app_sessions_app on hosted.app_sessions (app_id);
create index if not exists app_sessions_grant on hosted.app_sessions (grant_id);

/* ------------------------------ app_exchanges ------------------------------ */

create table if not exists hosted.app_exchanges (
  code_hash   text not null primary key check (char_length(code_hash) = 64),
  app_id      text not null references hosted.apps(id),
  subject     text not null,
  grant_id    text not null references hosted.app_grants(id),
  -- The opaque browser state echoed back on redemption (AppExchange.state).
  -- Round-tripped, never interpreted, and never overwritten: the lifecycle
  -- lives in the status column so redemption can still answer with it.
  state       text not null,
  status      text not null check (status in ('pending','consumed','expired')),
  created_at  text not null,
  expires_at  text not null,
  consumed_at text,
  session_id  text references hosted.app_sessions(id) on delete set null,
  check ((status = 'consumed') = (consumed_at is not null))
);
create index if not exists app_exchanges_expiry on hosted.app_exchanges (expires_at);

/* ------------------------------- hosted_jobs ------------------------------- */

create table if not exists hosted.hosted_jobs (
  id           text    not null primary key,
  kind         text    not null check (kind in ('publish','rollback','suspend','resume','export','restore')),
  workspace_id text    not null,
  app_id       text    not null references hosted.apps(id),
  actor        text    not null,
  intent_hash  text    not null check (char_length(intent_hash) = 64),
  status       text    not null check (status in ('queued','running','succeeded','failed','cancelled')),
  -- Deliberately unconstrained: `phase` is owned by the job runner, and a CHECK
  -- here would turn a documented open question into a migration. TypeScript
  -- narrows it; the looseness stops at the database boundary.
  phase        text    not null,
  phase_data   text    not null default '{}',
  attempts     integer not null default 0 check (attempts >= 0),
  lease_owner  text,
  lease_until  text,
  fence_token  bigint  not null default 0 check (fence_token >= 0),
  result       text,
  error        text,
  created_at   text    not null,
  updated_at   text    not null,
  finished_at  text
);
-- Single flight: the database, not a code path, is what makes two publishes
-- for one app impossible. A second claim fails on this index.
create unique index if not exists hosted_jobs_single_flight on hosted.hosted_jobs (app_id) where status = 'running';
create index if not exists hosted_jobs_app on hosted.hosted_jobs (app_id, created_at);
create index if not exists hosted_jobs_status on hosted.hosted_jobs (status, lease_until);

/* ------------------------------ hosted_outbox ------------------------------ */

create table if not exists hosted.hosted_outbox (
  id              text    not null primary key,
  idempotency_key text    not null unique,
  kind            text    not null check (kind in ('invite_email','revocation_ledger','provider_cleanup','spend_alert','webhook')),
  payload         text    not null,
  state           text    not null check (state in ('pending','sending','done','failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  created_at      text    not null,
  claimed_at      text,
  settled_at      text,
  error           text
);
create index if not exists hosted_outbox_state on hosted.hosted_outbox (state, created_at);

/* -------------------------------- artifacts -------------------------------- */

create table if not exists hosted.artifacts (
  digest      text   not null primary key check (char_length(digest) = 64),
  byte_size   bigint not null check (byte_size >= 0),
  file_count  bigint not null check (file_count >= 0),
  provenance  text   not null,
  created_at  text   not null,
  verified_at text
);

/* -------------------------------- releases --------------------------------- */

create table if not exists hosted.releases (
  id              text    not null primary key,
  app_id          text    not null references hosted.apps(id),
  number          bigint  not null check (number >= 1),
  artifact_digest text    not null references hosted.artifacts(digest),
  schema_version  integer not null check (schema_version = 1),
  job_id          text    not null,
  status          text    not null check (status in ('candidate','verified','active','superseded','failed','rolled_back')),
  runtime         text    not null check (runtime in ('local','cloudflare')),
  runtime_ref     text    not null default '{}',
  probe           text,
  created_at      text    not null,
  verified_at     text,
  activated_at    text,
  superseded_at   text,
  error           text,
  unique (app_id, number)
);
create index if not exists releases_app on hosted.releases (app_id, number);
create index if not exists releases_artifact on hosted.releases (artifact_digest);

-- The back-reference SQLite declared inline on `apps`. Guarded so re-applying
-- this file does not fail on an existing constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'apps_active_release_id_fkey'
      and connamespace = 'hosted'::regnamespace
  ) then
    alter table hosted.apps
      add constraint apps_active_release_id_fkey
      foreign key (active_release_id) references hosted.releases(id);
  end if;
end $$;

/* ------------------------------ quota_counters ----------------------------- */

create table if not exists hosted.quota_counters (
  app_id   text    not null references hosted.apps(id),
  -- SQLite's `day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`.
  day      text    not null check (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  requests bigint  not null default 0 check (requests >= 0),
  denied   bigint  not null default 0 check (denied >= 0),
  primary key (app_id, day)
);

/* ------------------------------- usage_ledger ------------------------------ */

create table if not exists hosted.usage_ledger (
  id           text not null primary key,
  workspace_id text not null,
  app_id       text references hosted.apps(id),
  kind         text not null check (kind in ('build_ms','requests','storage_bytes','emails','provider_usd')),
  amount       double precision not null,
  at           text not null,
  note         text
);
create index if not exists usage_ledger_workspace on hosted.usage_ledger (workspace_id, at);
create index if not exists usage_ledger_app on hosted.usage_ledger (app_id, at);

/* ---------------------------- revocation_ledger ---------------------------- */

-- No foreign key on app_id, and that is the point: this ledger is copied
-- off-host and reconciled against a *restored older snapshot*, in which the
-- app row may not exist yet. A reference to a table it has to outlive would
-- make the reconciliation G23 asks for impossible.
create table if not exists hosted.revocation_ledger (
  seq      bigint generated always as identity primary key,
  at       text not null,
  app_id   text not null,
  grant_id text not null,
  subject  text not null,
  by       text not null,
  reason   text not null
);
create index if not exists revocation_ledger_subject on hosted.revocation_ledger (subject);

/* ----------------------------- backup_manifests ---------------------------- */

create table if not exists hosted.backup_manifests (
  id             text   not null primary key,
  created_at     text   not null,
  digest         text   not null,
  byte_size      bigint not null check (byte_size >= 0),
  files          text   not null,
  revocation_seq bigint not null check (revocation_seq >= 0),
  key_id         text   not null
);
create index if not exists backup_manifests_created on hosted.backup_manifests (created_at);

/* ------------------------------ hosted_events ------------------------------ */

create table if not exists hosted.hosted_events (
  id           text    not null primary key,
  -- Deliberately unconstrained vocabulary: PLAN-R3 R3-13 records it as
  -- provisional. TypeScript narrows it (`HostedEventName`).
  event        text    not null check (char_length(event) > 0),
  ts           text    not null,
  workspace_id text    not null,
  app_id       text,
  subject_hash text,
  release_id   text,
  outcome      text    not null check (outcome in ('ok','error','denied')),
  logical_id   text,
  -- SQLite stored 0/1 under a CHECK; a flag is a boolean in Postgres.
  assisted     boolean not null,
  actor_class  text    not null check (actor_class in ('founder','test','external','system')),
  props        text
);
-- One row per logical operation. Rows without a logical id are not deduped:
-- SQL NULL is never equal to itself, so they simply do not enter this index.
create unique index if not exists hosted_events_logical on hosted.hosted_events (event, logical_id) where logical_id is not null;
create index if not exists hosted_events_ts on hosted.hosted_events (ts);
create index if not exists hosted_events_app on hosted.hosted_events (app_id, ts);

/* ----------------------------- row level security -------------------------- */

-- Enabled everywhere, with no policies: service role only. See the header.
alter table hosted.schema_migrations  enable row level security;
alter table hosted.apps               enable row level security;
alter table hosted.app_grants         enable row level security;
alter table hosted.app_invites        enable row level security;
alter table hosted.invite_deliveries  enable row level security;
alter table hosted.app_sessions       enable row level security;
alter table hosted.app_exchanges      enable row level security;
alter table hosted.hosted_jobs        enable row level security;
alter table hosted.hosted_outbox      enable row level security;
alter table hosted.artifacts          enable row level security;
alter table hosted.releases           enable row level security;
alter table hosted.quota_counters     enable row level security;
alter table hosted.usage_ledger       enable row level security;
alter table hosted.revocation_ledger  enable row level security;
alter table hosted.backup_manifests   enable row level security;
alter table hosted.hosted_events      enable row level security;

/* --------------------------------- grants --------------------------------- */

-- Service role is the only identity that reads or writes these tables. A table
-- created by the postgres owner carries no privileges for other roles, so the
-- grants are explicit; anon and authenticated deliberately receive none (RLS is
-- on with no policies, so even a grant would show them nothing).
grant usage on schema hosted to service_role;
grant select, insert, update, delete on all tables in schema hosted to service_role;
grant usage, select, update on all sequences in schema hosted to service_role;
alter default privileges in schema hosted grant select, insert, update, delete on tables to service_role;
alter default privileges in schema hosted grant usage, select, update on sequences to service_role;

/* ------------------------------- seed versions ----------------------------- */

-- Every version in `MIGRATIONS` (src/lib/hosted/authority/schema.ts). This file
-- *is* those versions, so the ledger records them as applied. The Postgres
-- authority refuses to boot if the newest one is missing here.
insert into hosted.schema_migrations (version, name, applied_at) values
  (1, 'control-authority-v1',            '2026-01-01T00:00:00.000Z'),
  (2, 'invite-delivery-transport-none',  '2026-01-01T00:00:00.000Z')
on conflict (version) do nothing;
