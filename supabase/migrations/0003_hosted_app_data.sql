-- Zenith hosted app data — the per-app customer data plane in Postgres.
--
-- Replaces "one SQLite file per app" (src/lib/hosted/data/open.ts) when
-- ZENITH_HOSTED_STORE=postgres. The isolation property changes shape and must
-- not change meaning: on SQLite an app reaches only its own data because it
-- opens only its own file; here every table carries `app_id` in its PRIMARY KEY
-- and `PgDataBackend` (src/lib/hosted/data/pg-backend.ts) binds one instance to
-- one app id and puts `app_id = eq.<that app>` on every single request. There is
-- no code path in that class that takes an app id per statement.
--
-- Shape, uniformly:
--   app_id        text    the tenant; first column of every primary key
--   <promoted>            only the columns a real query filters or sorts on
--   body          jsonb   the contract record verbatim (tracker-v1), so
--                         `toRecord` sees exactly the fields it saw on SQLite
--
-- `created_at` / `updated_at` / `at` are TEXT, not timestamptz, on purpose: the
-- tracker contract stores ISO-8601 strings minted by `new Date().toISOString()`,
-- the page cursor is built from that exact string (tracker-rows.ts
-- `encodeCursor`), and keyset pagination compares the stored value with the
-- cursor's. A timestamptz round trip would reformat it (`+00` instead of `Z`,
-- microseconds instead of milliseconds) and the cursor would stop matching.
-- Lexicographic ordering of a fixed-width ISO-8601 UTC string is the same
-- ordering as the instant it names, so the index below is a correct ordering
-- index.
--
-- Idempotent on purpose: `create ... if not exists` / `create or replace`
-- throughout, so re-applying it is a no-op.
--
-- Row level security is ON for every table and NO policies are defined, exactly
-- as in 0001/0002: the service role bypasses RLS and is the only identity that
-- ever reaches these tables. The browser never talks to PostgREST for hosted app
-- data — the fixed broker does, server side, holding SUPABASE_SERVICE_ROLE_KEY.
--
-- DEPLOYMENT NOTE: PostgREST only serves schemas listed as "Exposed schemas"
-- (Supabase dashboard → Settings → API, or `db-schemas` in postgrest.conf).
-- `hosted` must be added there, otherwise every request from PgDataBackend
-- answers PGRST106 "The schema must be one of the following". The backend turns
-- that into a `runtime_unavailable` refusal that names this step.

create schema if not exists hosted;

/* ------------------------------- app_records ------------------------------ */

-- One equipment request. `body` is the frozen tracker-v1 record (contracts/
-- tracker-v1.ts) exactly as `toRecord` expects it, camelCase and all; the
-- promoted columns are the ones a query actually filters or sorts on.
--
-- `version` and `logical_bytes` are promoted because they are read and compared
-- without hydrating the record: the compare-and-swap guard is `where version =
-- <expected>`, and an update's byte delta is `new - old` off the stored value.
-- `subject` is the record's creator (`body->>'createdBy'`), promoted because
-- "requests I raised" is a per-subject read and a jsonb expression index is a
-- worse fit for it than a plain column.
create table if not exists hosted.app_records (
  app_id        text    not null,
  record_id     text    not null,
  subject       text    not null,
  version       integer not null check (version >= 1),
  logical_bytes integer not null check (logical_bytes >= 0),
  body          jsonb   not null,
  created_at    text    not null,
  updated_at    text    not null,
  primary key (app_id, record_id)
);

-- Keyset pagination: `order by created_at desc, record_id desc` with a
-- `(created_at, record_id) < (cursor.at, cursor.id)` predicate, never OFFSET.
-- The column order matches that exactly, so one page is one index range scan
-- inside one app.
create index if not exists app_records_page_idx
  on hosted.app_records (app_id, created_at desc, record_id desc);

-- The tracker's two list filters (tracker-store.ts `list` → SELECT_REQUESTS_PAGE
-- parameters 1–4). Both are jsonb expression indexes because status and category
-- live in `body`; both carry `created_at desc` so a filtered page is still an
-- ordered range scan rather than a filter-then-sort.
create index if not exists app_records_status_idx
  on hosted.app_records (app_id, (body ->> 'status'), created_at desc);

create index if not exists app_records_category_idx
  on hosted.app_records (app_id, (body ->> 'category'), created_at desc);

-- "what did this person raise", and the per-subject reads the app's own screens
-- do. Ordered, for the same reason as above.
create index if not exists app_records_subject_idx
  on hosted.app_records (app_id, subject, created_at desc);

/* ------------------------------- app_writes ------------------------------- */

-- The idempotency ledger: one row per accepted mutation, written in the same
-- round trip family as the mutation itself. A retry of the same `write_id`
-- replays `result`; a retry carrying a *different* intent hash is refused rather
-- than applied twice (decision R3-08, tracker-store.ts `replayOf`).
--
-- DEVIATION: the approved column list was (app_id, write_id, record_id, at).
-- `subject`, `op`, `intent_hash`, `status_code` and `result` are added because
-- the store's replay path reads all of them — without `intent_hash` a reused
-- write id carrying a different change could not be told from an honest retry,
-- and without `result` a replay could not answer the original record. They are
-- the same columns the SQLite `writes` table already has (sql.ts CREATE_WRITES).
create table if not exists hosted.app_writes (
  app_id      text    not null,
  write_id    text    not null,
  subject     text    not null,
  op          text    not null check (op in ('create', 'update')),
  record_id   text,
  intent_hash text    not null,
  status_code integer not null check (status_code between 100 and 599),
  result      jsonb   not null,
  at          text    not null,
  primary key (app_id, write_id)
);

-- The retention sweep deletes by age within one app
-- (TRACKER_LIMITS.writeIdRetentionMs → DELETE_WRITES_BEFORE).
create index if not exists app_writes_at_idx on hosted.app_writes (app_id, at);

/* ------------------------------- app_storage ------------------------------ */

-- The running total of logical bytes for one app, so the quota decision is one
-- comparison inside the insert's own statement rather than a table scan. See
-- src/lib/hosted/data/bytes.ts for what a logical byte is and is not — it is
-- explicitly not the physical size of anything in this database.
create table if not exists hosted.app_storage (
  app_id        text   primary key,
  logical_bytes bigint not null default 0 check (logical_bytes >= 0)
);

/* -------------------------------- functions ------------------------------- */

-- Quota admission as ONE round trip, the Postgres counterpart of
-- INSERT_REQUEST_WITHIN_QUOTA (sql.ts): the comparison is part of the write, so
-- the decision and the effect cannot come apart and a caller cannot squeeze a
-- row in between them.
--
-- Returns the number of rows inserted: 1 accepted, 0 refused. The caller reads
-- that as `changes` and turns 0 — and only 0 — into `quota_exceeded`, exactly as
-- the SQLite path judges `inserted.changes !== 1`.
--
-- The storage counter moves inside the same statement family, so an accepted
-- insert can never leave the total behind. `security definer` with a pinned
-- `search_path` because it writes two tables under RLS; only service_role may
-- execute it (the grant block below).
create or replace function hosted.app_record_insert_within_quota(
  p_app_id        text,
  p_record_id     text,
  p_subject       text,
  p_version       integer,
  p_logical_bytes integer,
  p_body          jsonb,
  p_created_at    text,
  p_updated_at    text,
  p_limit_bytes   bigint
) returns integer
language plpgsql
security definer
set search_path = hosted, pg_catalog
as $$
declare
  v_used     bigint;
  v_inserted integer;
begin
  -- Serialises concurrent writers for this app only: the row is locked for the
  -- length of the statement, so two creates that each fit alone but not together
  -- cannot both read the same "used" figure and both be admitted.
  insert into hosted.app_storage (app_id, logical_bytes)
  values (p_app_id, 0)
  on conflict (app_id) do nothing;

  select logical_bytes into v_used
  from hosted.app_storage
  where app_id = p_app_id
  for update;

  if v_used + p_logical_bytes > p_limit_bytes then
    return 0;
  end if;

  insert into hosted.app_records
    (app_id, record_id, subject, version, logical_bytes, body, created_at, updated_at)
  values
    (p_app_id, p_record_id, p_subject, p_version, p_logical_bytes, p_body, p_created_at, p_updated_at)
  on conflict (app_id, record_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 0;
  end if;

  update hosted.app_storage
  set logical_bytes = logical_bytes + p_logical_bytes
  where app_id = p_app_id;

  return 1;
end;
$$;

-- Applies a signed delta to one app's counter: an update that grows a record
-- adds, one that shrinks it subtracts. PostgREST cannot express
-- `logical_bytes = logical_bytes + ?` as a PATCH, so the increment is a function
-- rather than a read-modify-write the application could lose a race on. This is
-- the counterpart of UPDATE_STORAGE_ADD.
--
-- Clamped at zero by the column's CHECK; a delta that would drive the total
-- negative means the counter and the rows have already diverged, and failing
-- loudly is better than recording a negative usage figure.
create or replace function hosted.app_storage_add(
  p_app_id text,
  p_delta  bigint
) returns bigint
language plpgsql
security definer
set search_path = hosted, pg_catalog
as $$
declare
  v_total bigint;
begin
  insert into hosted.app_storage (app_id, logical_bytes)
  values (p_app_id, 0)
  on conflict (app_id) do nothing;

  update hosted.app_storage
  set logical_bytes = logical_bytes + p_delta
  where app_id = p_app_id
  returning logical_bytes into v_total;

  return coalesce(v_total, 0);
end;
$$;

/* ----------------------------- row level security -------------------------- */

-- Enabled everywhere, with no policies: service role only. See the header.
alter table hosted.app_records enable row level security;
alter table hosted.app_writes  enable row level security;
alter table hosted.app_storage enable row level security;

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

-- The two functions are `security definer`, so EXECUTE is the whole access
-- decision. PUBLIC gets none; only the service role may call them.
revoke all on function hosted.app_record_insert_within_quota(
  text, text, text, integer, integer, jsonb, text, text, bigint
) from public;
revoke all on function hosted.app_storage_add(text, bigint) from public;

grant execute on function hosted.app_record_insert_within_quota(
  text, text, text, integer, integer, jsonb, text, text, bigint
) to service_role;
grant execute on function hosted.app_storage_add(text, bigint) to service_role;
