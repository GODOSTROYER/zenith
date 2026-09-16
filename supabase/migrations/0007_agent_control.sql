-- Zenith agent control plane — the reviewed-operation journal on Supabase.
--
-- This is `src/lib/agent-access/control/journal.ts`'s SQLite schema translated
-- into the `agent` schema, plus the coordination columns a single-writer file
-- never needed: a fence token, a lease and an attempt counter. It is what makes
-- reviewed writes possible on a host where a hundred instances can be running
-- the same code at the same time and none of them owns a data directory.
--
-- **Two migrations create this schema, not one.** `0006_agent_link.sql`
-- (credentials, link codes, rate limits) and this file (operations, events,
-- uploads) are written by different packets working in parallel. Both
-- `create schema if not exists agent`, both carry the full grant block, both
-- are idempotent, and they record different ledger versions — so either order
-- works and re-applying either is a no-op. `0002`/`0003` already work this way.
--
-- **Timestamps are `text`, deliberately**, for exactly the reason
-- `0002_hosted_authority.sql`'s header gives: every value stored here is
-- `Date#toISOString()`, fixed width `YYYY-MM-DDTHH:MM:SS.sssZ`, so lexicographic
-- comparison *is* chronological comparison and `expires_at > $1` /
-- `lease_until <= $1` mean precisely the same thing on the file store and here.
-- A `timestamptz` column would change the boundary semantics of the lease that
-- decides whether an interrupted dispatch is reclaimed.
--
-- **`document jsonb` mirrors the SQLite journal's `document TEXT`.** The
-- denormalised columns beside it exist for indexes and for the guarded `UPDATE`
-- predicates only; the `Operation` the application reads is always the
-- document, so one shape serves both stores and `operationView()` needs no
-- branch.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that ever reaches these tables. `agent`
-- is **not** added to the Data API's exposed schemas — nothing here is reached
-- over PostgREST, and exposing it would publish credential rows.
--
-- Idempotent throughout. Applied by hand by the operator (docs/HOSTED-POSTGRES.md
-- §3); nothing in the application ever runs DDL.

create schema if not exists agent;

/* ----------------------------- schema ledger ------------------------------- */

-- Also created by 0006 so that either file may be applied first.
create table if not exists agent.schema_migrations (
  version    integer not null primary key,
  name       text    not null,
  applied_at text    not null
);

/* ---------------------------- agent_operations ----------------------------- */

create table if not exists agent.agent_operations (
  id             text   not null primary key,            -- 'op_' || uuid
  workspace_id   text   not null,
  subject        text   not null,
  integration_id text   not null,                        -- credential id, or the OAuth integration id
  request_key    text   not null,
  intent_hash    text   not null check (intent_hash ~ '^[0-9a-f]{64}$'),
  digest         text   not null check (digest       ~ '^[0-9a-f]{64}$'),
  phase          text   not null
                 check (phase in ('prepared','approved','rejected','running',
                                  'succeeded','failed','uncertain','expired')),
  action         text   not null,
  project_id     text   not null,
  environment_id text,
  document       jsonb  not null,
  created_at     text   not null,
  expires_at     text   not null,
  approved_by    text,
  approval_role  text   check (approval_role in ('editor','admin')),
  approved_at    text,
  finished_at    text,
  -- coordination: what replaces the pid file and the in-process worker id
  fence_token    bigint  not null default 0,
  lease_owner    text,
  lease_until    text,
  attempts       integer not null default 0,
  authorization_digest             text,
  application_authorization_digest text,
  -- The same uniqueness the SQLite journal declares. Idempotent prepare is a
  -- database fact on both stores, never a cache.
  unique (workspace_id, subject, request_key)
);

create index if not exists agent_operations_scope
  on agent.agent_operations (workspace_id, subject, created_at desc);
create index if not exists agent_operations_review
  on agent.agent_operations (workspace_id, phase, created_at desc)
  where phase in ('prepared','approved');
-- The reconciliation scan (`agentTickPass`): bounded and index-only.
create index if not exists agent_operations_leased
  on agent.agent_operations (lease_until)
  where phase = 'running';
create index if not exists agent_operations_pending_expiry
  on agent.agent_operations (expires_at)
  where phase in ('prepared','approved');

-- Deliberately NO partial unique index on (project_id) where phase='running'.
-- Two approved operations on two projects of one workspace may legitimately run
-- at once, and serialising them would be a scalability decision dressed as
-- safety. The single-use property that matters — this operation dispatches at
-- most once — is carried by `phase = 'approved'` in the claim's WHERE, which is
-- a primary-key-guarded conditional update and is therefore already exclusive.

/* -------------------------- agent_operation_events ------------------------- */

create table if not exists agent.agent_operation_events (
  seq          bigint generated always as identity primary key,
  operation_id text  not null references agent.agent_operations (id) on delete cascade,
  kind         text  not null,
  at           text  not null,
  document     jsonb not null
);
create index if not exists agent_operation_events_op
  on agent.agent_operation_events (operation_id, seq);

/* ------------------------------ agent_uploads ------------------------------ */

create table if not exists agent.agent_uploads (
  id           text  not null primary key,
  subject      text  not null,
  workspace_id text  not null,
  project_id   text  not null,
  app_id       text  not null,
  sha256       text  not null check (sha256 ~ '^[0-9a-f]{64}$'),
  expires_at   text  not null,
  bytes        bytea not null
);
create index if not exists agent_uploads_workspace
  on agent.agent_uploads (workspace_id, expires_at);

/* ----------------------------- row level security -------------------------- */

alter table agent.schema_migrations      enable row level security;
alter table agent.agent_operations       enable row level security;
alter table agent.agent_operation_events enable row level security;
alter table agent.agent_uploads          enable row level security;

/* --------------------------------- grants ---------------------------------- */

-- Service role is the only identity that reads or writes these tables. A table
-- created by the postgres owner carries no privileges for other roles, so the
-- grants are explicit; anon and authenticated deliberately receive none (RLS is
-- on with no policies, so even a grant would show them nothing).
grant usage on schema agent to service_role;
grant select, insert, update, delete on all tables in schema agent to service_role;
grant usage, select, update on all sequences in schema agent to service_role;
alter default privileges in schema agent grant select, insert, update, delete on tables to service_role;
alter default privileges in schema agent grant usage, select, update on sequences to service_role;

/* ------------------------------- seed versions ----------------------------- */

-- `pgAgentJournal()` refuses every read and write until this row is present.
-- 0006 records version 1 ('agent-link-v1'); this file records version 2.
insert into agent.schema_migrations (version, name, applied_at) values
  (2, 'agent-control-v1', '2026-01-01T00:00:00.000Z')
on conflict (version) do nothing;
