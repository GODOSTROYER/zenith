-- Zenith agent link — browser-issued agent credentials and the device flow
-- that mints them (LINK-PROTOCOL.md §3.2).
--
-- **A new schema, `agent`, and deliberately neither of the two that exist.**
-- `public` is served by PostgREST and frozen by 0001_system_of_record.sql, and
-- putting credential rows there would publish them to the Data API surface.
-- `hosted` is gated by the hosted authority's schema-version check, which
-- refuses every request below its newest version — coupling an agent-link
-- outage to a hosted-apps migration. `agent` carries its own
-- `agent.schema_migrations` ledger and is checked the same way, independently.
--
-- **`agent` is not added to the Data API's exposed schemas.** Nothing in here
-- is reachable over PostgREST at all; the only identity that ever touches these
-- tables is the service role, over the Supavisor transaction-mode pooler.
--
-- **Timestamps stay `text`**, for the reason 0002_hosted_authority.sql's header
-- states verbatim: every value is `Date#toISOString()` — fixed width
-- `YYYY-MM-DDTHH:MM:SS.sssZ` — so lexicographic comparison *is* chronological
-- comparison and `expires_at > $1` is a plain string predicate that means the
-- same thing on the file store and on Postgres. A `timestamptz` column here
-- would make the two implementations disagree about a boundary. Do not
-- "improve" it.
--
-- **No secret is stored in the clear.** `token_hash` is sha256 hex of a bearer
-- this database never sees; `secret_ct` holds the issued token sealed with
-- AES-256-GCM under the server's ZENITH_SECRET_KEY for the at-most-ten-minutes
-- between approval and the poll that consumes it, and the same statement that
-- consumes the row sets it to null.
--
-- Idempotent throughout (`create schema/table/index if not exists`,
-- `on conflict do nothing`), so re-applying it is a no-op. Applied by hand by
-- the operator in the Supabase SQL editor, or with psql against SUPABASE_DB_URL.

create schema if not exists agent;

/* ---------------------------- schema_migrations ---------------------------- */

-- The runtime does not apply migrations; it reads this table before its first
-- statement and refuses with the file to apply if this version is missing.
create table if not exists agent.schema_migrations (
  version    integer not null primary key,
  name       text    not null,
  applied_at text    not null
);

/* ----------------------------- agent_credentials --------------------------- */

create table if not exists agent.agent_credentials (
  id             text  not null primary key,          -- 'cred_' || uuid
  token_hash     text  not null unique
                 check (token_hash ~ '^[0-9a-f]{64}$'),-- sha256(secret) hex; the secret is never stored
  subject        text  not null,
  workspace_id   text  not null,
  project_ids    jsonb not null,                       -- string[]; >= 1 entry
  environment_ids jsonb,                               -- string[] or null (= all)
  app_ids        jsonb,                                -- string[] or null
  scopes         jsonb not null,                       -- string[] including 'read'
  label          text,
  client_name    text  not null,
  client_version text,
  issued_at      text  not null,                       -- ISO-8601 UTC, fixed width (see the header)
  expires_at     text  not null,
  revoked_at     text,
  last_used_at   text,
  created_by     text  not null,                       -- the approving member; == subject in phase 1
  check (jsonb_array_length(project_ids) between 1 and 100),
  check (jsonb_array_length(scopes)      between 1 and 6)
);

create index if not exists agent_credentials_subject
  on agent.agent_credentials (subject, workspace_id, issued_at desc);
create index if not exists agent_credentials_live
  on agent.agent_credentials (workspace_id) where revoked_at is null;

/* ------------------------------ agent_link_codes --------------------------- */

create table if not exists agent.agent_link_codes (
  user_code_hash   text not null primary key
                   check (user_code_hash ~ '^[0-9a-f]{64}$'),
  device_code_hash text not null unique
                   check (device_code_hash ~ '^[0-9a-f]{64}$'),
  state            text not null
                   check (state in ('pending','approved','denied','consumed','expired')),
  client_name      text not null,
  client_version   text,
  label            text,
  requested_scopes jsonb not null,
  created_at       text not null,
  expires_at       text not null,
  approved_at      text,
  approved_by      text,
  credential_id    text references agent.agent_credentials (id),
  secret_ct        bytea,           -- the issued token, encrypted; nulled on exchange
  poll_count       integer not null default 0,
  last_polled_at   text,
  failed_lookups   integer not null default 0
);

create index if not exists agent_link_codes_expiry on agent.agent_link_codes (expires_at);

/* ------------------------------ agent_rate_limits -------------------------- */

-- One fixed window per (scope, key). The key is a salted digest of the
-- principal or the client address, never the address itself, so this table
-- cannot be turned back into a list of who called.
create table if not exists agent.agent_rate_limits (
  scope   text    not null,   -- 'link.start' | 'link.poll' | 'link.lookup' | 'v1' | 'v2'
  key     text    not null,   -- sha256 hex of the principal or the salted client address
  bucket  bigint  not null,   -- floor(epoch_ms / window_ms)
  count   integer not null check (count >= 0),
  primary key (scope, key, bucket)
);

create index if not exists agent_rate_limits_bucket on agent.agent_rate_limits (bucket);

/* --------------------------------- grants ---------------------------------- */

-- Row level security ON with NO policies, exactly as `hosted` does it: the
-- service role bypasses RLS and is the only identity that ever reaches these
-- tables; anon and authenticated see nothing at all. A table created by the
-- postgres owner carries no privileges for other roles, so the grants below are
-- explicit.
alter table agent.schema_migrations enable row level security;
alter table agent.agent_credentials enable row level security;
alter table agent.agent_link_codes  enable row level security;
alter table agent.agent_rate_limits enable row level security;

grant usage on schema agent to service_role;
grant select, insert, update, delete on all tables in schema agent to service_role;
grant usage, select, update on all sequences in schema agent to service_role;
alter default privileges in schema agent grant select, insert, update, delete on tables to service_role;
alter default privileges in schema agent grant usage, select, update on sequences to service_role;

/* ------------------------------- seed versions ------------------------------ */

-- This file *is* version 1 of the agent schema, so the ledger records it as
-- applied. `PgCredentialAuthority` refuses every request until it finds it.
insert into agent.schema_migrations (version, name, applied_at) values
  (1, 'agent-link-v1', '2026-01-01T00:00:00.000Z')
on conflict (version) do nothing;
