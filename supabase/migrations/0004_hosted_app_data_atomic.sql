-- Zenith hosted app data — one transaction per mutation.
--
-- Closes the ceiling recorded at the top of src/lib/hosted/data/pg-backend.ts:
-- on SQLite the record, the storage counter and the idempotency ledger row
-- commit together inside `BEGIN IMMEDIATE`; over PostgREST they were three
-- separate round trips, so a process killed between the accepted insert and the
-- ledger write left a record whose write id was never recorded — and a retry of
-- that write id would then create a second record.
--
-- A plpgsql function body runs inside one transaction, so the two functions
-- below are exactly that missing `BEGIN IMMEDIATE`: each one reserves the write
-- id, compares the quota, writes the row and moves the counter, and either all
-- of it commits or none of it does.
--
-- WHAT DOES NOT MOVE INTO THE DATABASE. The tracker's policy stays in
-- `tracker-store.ts` / `PgTrackerStore`: validation, the byte measure, the
-- intent hash, the merge of a patch into the stored record, the role check and
-- every refusal's wording. These functions decide nothing the SQLite statements
-- do not already decide — they compare the quota (as
-- INSERT_REQUEST_WITHIN_QUOTA's WHERE clause does), guard the version (as
-- UPDATE_REQUEST_CAS's WHERE clause does) and reserve the write id (as the
-- ledger's PRIMARY KEY does). What comes back is an outcome tag the store turns
-- into the same `HostedError` it would have thrown on SQLite.
--
-- Migration 0003 is NOT edited and nothing here drops: its
-- `app_record_insert_within_quota` and `app_storage_add` stay in place and stay
-- in use — the import path (src/lib/hosted/export) still admits records through
-- the former, and an update's byte delta on the non-atomic path through the
-- latter.
--
-- Idempotent: `create or replace` throughout, so re-applying this file is a
-- no-op. Both functions are `security definer` with a pinned `search_path` and
-- are executable by service_role only, exactly as 0003's are.
--
-- DEPLOYMENT: apply this file in the Supabase SQL editor (or
-- `supabase db push`). Until it is applied, PgDataBackend's create and update
-- paths answer `runtime_unavailable` naming this file, and the live contract
-- tests for those two paths skip with the same instruction.
--
-- PostgREST serves functions out of a cached schema, and it reloads that cache
-- on a DDL event notice; if `rpc/app_record_create_atomic` still answers
-- PGRST202 a minute after applying this, run
-- `notify pgrst, 'reload schema';` once. `hosted` must already be in the
-- project's exposed schemas (Settings → API) — that is 0003's deployment note
-- and nothing here changes it.

create schema if not exists hosted;

/* --------------------------------- create --------------------------------- */

-- One created record, its quota admission, its counter movement and its ledger
-- row, in one transaction.
--
-- Order matters and is the whole point:
--
--   1. lock this app's counter row (`for update`) and compare the quota. A
--      refusal returns before anything is written.
--   2. reserve the write id. `on conflict do nothing` inserting zero rows means
--      another caller holds it; the store re-reads the ledger and either replays
--      it or refuses the reuse, which is what it already does on SQLite.
--   3. insert the record. A colliding record id cannot happen with the store's
--      v4 UUIDs; if it ever did, the ledger row reserved in step 2 is removed
--      again so the write id is not burned on a mutation that did not happen.
--   4. move the counter.
--
-- Returns a jsonb envelope:
--   {"outcome":"ok",             "storage_bytes":<bigint>}
--   {"outcome":"quota_exceeded", "storage_bytes":<bigint>}   nothing written
--   {"outcome":"write_id_taken"}                             nothing written
--   {"outcome":"record_exists"}                              nothing written
--
-- `storage_bytes` on a refusal is the figure the quota refusal reports, so the
-- store does not need a second round trip to say how full the app is.
create or replace function hosted.app_record_create_atomic(
  p_app_id        text,
  p_record_id     text,
  p_subject       text,
  p_version       integer,
  p_logical_bytes integer,
  p_body          jsonb,
  p_created_at    text,
  p_updated_at    text,
  p_limit_bytes   bigint,
  p_write_id      text,
  p_intent_hash   text,
  p_status_code   integer,
  p_result        jsonb,
  p_at            text
) returns jsonb
language plpgsql
security definer
set search_path = hosted, pg_catalog
as $$
declare
  v_used     bigint;
  v_rows     integer;
  v_total    bigint;
begin
  insert into hosted.app_storage (app_id, logical_bytes)
  values (p_app_id, 0)
  on conflict (app_id) do nothing;

  -- Serialises concurrent writers for this app only: two creates that each fit
  -- alone but not together cannot both read the same "used" figure.
  select logical_bytes into v_used
  from hosted.app_storage
  where app_id = p_app_id
  for update;

  if v_used + p_logical_bytes > p_limit_bytes then
    return jsonb_build_object('outcome', 'quota_exceeded', 'storage_bytes', v_used);
  end if;

  insert into hosted.app_writes
    (app_id, write_id, subject, op, record_id, intent_hash, status_code, result, at)
  values
    (p_app_id, p_write_id, p_subject, 'create', p_record_id, p_intent_hash, p_status_code, p_result, p_at)
  on conflict (app_id, write_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('outcome', 'write_id_taken');
  end if;

  insert into hosted.app_records
    (app_id, record_id, subject, version, logical_bytes, body, created_at, updated_at)
  values
    (p_app_id, p_record_id, p_subject, p_version, p_logical_bytes, p_body, p_created_at, p_updated_at)
  on conflict (app_id, record_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- Give the write id back: it was reserved for a mutation that is not
    -- happening, and a burned write id would refuse the caller's honest retry.
    delete from hosted.app_writes where app_id = p_app_id and write_id = p_write_id;
    return jsonb_build_object('outcome', 'record_exists');
  end if;

  update hosted.app_storage
  set logical_bytes = logical_bytes + p_logical_bytes
  where app_id = p_app_id
  returning logical_bytes into v_total;

  return jsonb_build_object('outcome', 'ok', 'storage_bytes', coalesce(v_total, 0));
end;
$$;

/* --------------------------------- update --------------------------------- */

-- One updated record, its version guard, its counter delta and its ledger row,
-- in one transaction.
--
-- The patch itself is NOT applied here: `p_body` is the whole next record as
-- the store merged it, measured by the same `logicalBytes()` both stores use.
-- What this function owns is the four things that must not come apart —
--
--   1. the row is locked and its version compared. A record that is gone
--      answers `not_found`; a version that moved answers `stale_version` and
--      carries the stored record back, so the caller reports what is actually
--      there rather than what it had read.
--   2. only growth can breach the quota (a patch that shrinks a record is
--      always allowed, which is what lets an app at its ceiling recover).
--   3. the write id is reserved, as in the create path.
--   4. the row is written and the counter moved by the delta.
--
-- Returns a jsonb envelope:
--   {"outcome":"ok",             "storage_bytes":<bigint>}
--   {"outcome":"not_found"}                                  nothing written
--   {"outcome":"stale_version",  "current":<jsonb record>}    nothing written
--   {"outcome":"quota_exceeded", "storage_bytes":<bigint>, "delta":<int>}
--   {"outcome":"write_id_taken"}                             nothing written
--
-- `current` is the stored `body` with the promoted `version` and `updated_at`
-- written over it: those columns are what the compare-and-swap actually
-- enforced, so if the two ever disagreed the column is the honest answer.
create or replace function hosted.app_record_update_atomic(
  p_app_id           text,
  p_record_id        text,
  p_expected_version integer,
  p_logical_bytes    integer,
  p_body             jsonb,
  p_updated_at       text,
  p_limit_bytes      bigint,
  p_subject          text,
  p_write_id         text,
  p_intent_hash      text,
  p_status_code      integer,
  p_result           jsonb,
  p_at               text
) returns jsonb
language plpgsql
security definer
set search_path = hosted, pg_catalog
as $$
declare
  v_version    integer;
  v_bytes      integer;
  v_body       jsonb;
  v_updated_at text;
  v_delta      integer;
  v_used       bigint;
  v_rows       integer;
  v_total      bigint;
begin
  select version, logical_bytes, body, updated_at
    into v_version, v_bytes, v_body, v_updated_at
  from hosted.app_records
  where app_id = p_app_id and record_id = p_record_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_version <> p_expected_version then
    return jsonb_build_object(
      'outcome', 'stale_version',
      'current', v_body || jsonb_build_object('version', v_version, 'updatedAt', v_updated_at)
    );
  end if;

  v_delta := p_logical_bytes - v_bytes;

  insert into hosted.app_storage (app_id, logical_bytes)
  values (p_app_id, 0)
  on conflict (app_id) do nothing;

  select logical_bytes into v_used
  from hosted.app_storage
  where app_id = p_app_id
  for update;

  if v_delta > 0 and v_used + v_delta > p_limit_bytes then
    return jsonb_build_object('outcome', 'quota_exceeded', 'storage_bytes', v_used, 'delta', v_delta);
  end if;

  insert into hosted.app_writes
    (app_id, write_id, subject, op, record_id, intent_hash, status_code, result, at)
  values
    (p_app_id, p_write_id, p_subject, 'update', p_record_id, p_intent_hash, p_status_code, p_result, p_at)
  on conflict (app_id, write_id) do nothing;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('outcome', 'write_id_taken');
  end if;

  update hosted.app_records
  set version       = p_expected_version + 1,
      logical_bytes = p_logical_bytes,
      body          = p_body,
      updated_at    = p_updated_at
  where app_id = p_app_id and record_id = p_record_id and version = p_expected_version;

  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    -- Unreachable: the row was locked above, so nothing can have moved it. If
    -- it ever happens, failing loudly rolls the whole function back rather than
    -- leaving a ledger row for a change that did not land.
    raise exception
      'hosted.app_record_update_atomic: the locked row changed under the swap (app % record %)',
      p_app_id, p_record_id;
  end if;

  if v_delta <> 0 then
    update hosted.app_storage
    set logical_bytes = logical_bytes + v_delta
    where app_id = p_app_id
    returning logical_bytes into v_total;
  else
    v_total := v_used;
  end if;

  return jsonb_build_object('outcome', 'ok', 'storage_bytes', coalesce(v_total, 0));
end;
$$;

/* --------------------------------- grants --------------------------------- */

-- `security definer`, so EXECUTE is the whole access decision: PUBLIC gets
-- none, service_role gets both. Identical to 0003's block.
revoke all on function hosted.app_record_create_atomic(
  text, text, text, integer, integer, jsonb, text, text, bigint, text, text, integer, jsonb, text
) from public;
revoke all on function hosted.app_record_update_atomic(
  text, text, integer, integer, jsonb, text, bigint, text, text, text, integer, jsonb, text
) from public;

grant execute on function hosted.app_record_create_atomic(
  text, text, text, integer, integer, jsonb, text, text, bigint, text, text, integer, jsonb, text
) to service_role;
grant execute on function hosted.app_record_update_atomic(
  text, text, integer, integer, jsonb, text, bigint, text, text, text, integer, jsonb, text
) to service_role;
