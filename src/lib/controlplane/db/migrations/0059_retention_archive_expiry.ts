/**
 * Archive expiry for the retention system (PROD-OPS-07, DEC-RETENTION archive expiry, 2026-10-14).
 *
 * Expand-only: three nullable columns on `platform.retention_archives` record that an archive OBJECT was deleted from
 * storage by Zenith (`expired_at`, `expired_by`, `expiry_outcome` = 'deleted' when Zenith removed the object, 'missing'
 * when the object was already gone). The record row itself is never deleted: it stays as the append-only audit of what
 * existed. A partial index serves the "due for expiry" scan.
 *
 * The guard trigger function is replaced (same name, same trigger) so that the record stays immutable apart from two
 * things: `pruned_rows` may grow (unchanged) and the expiry columns may be set exactly ONCE, all three together, and only
 * after every archived row has been pruned from the source (`completed_at` is set and `pruned_rows >= row_count`).
 * Once set they never change. No other column can change at the same time as the expiry is recorded.
 */
export const migration0059RetentionArchiveExpiry = {
  version: 59,
  name: "retention_archive_expiry",
  sql: `
alter table platform.retention_archives
  add column if not exists expired_at timestamptz,
  add column if not exists expired_by text check (expired_by is null or char_length(expired_by) between 1 and 128),
  add column if not exists expiry_outcome text check (expiry_outcome is null or expiry_outcome in ('deleted','missing'));

create index if not exists retention_archives_expiry_due on platform.retention_archives (last_recorded_at) where expired_at is null and completed_at is not null;

create or replace function platform.retention_archives_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Retention archive records are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.data_class, new.object_key, new.rows_digest, new.row_count, new.first_row_id, new.last_row_id, new.last_recorded_at, new.key_id, new.destination_id, new.destination_label, new.policy_digest, new.created_at, new.verified_at)
     is distinct from (old.id, old.workspace_id, old.data_class, old.object_key, old.rows_digest, old.row_count, old.first_row_id, old.last_row_id, old.last_recorded_at, old.key_id, old.destination_id, old.destination_label, old.policy_digest, old.created_at, old.verified_at)
     or new.pruned_rows < old.pruned_rows or (old.completed_at is not null and new.completed_at is distinct from old.completed_at) then
    raise exception 'Retention archive identity is immutable and pruned_rows only grows' using errcode = '23514';
  end if;
  if old.expired_at is not null or old.expired_by is not null or old.expiry_outcome is not null then
    if (new.expired_at, new.expired_by, new.expiry_outcome) is distinct from (old.expired_at, old.expired_by, old.expiry_outcome) then
      raise exception 'Retention archive expiry is recorded once and never changed' using errcode = '23514';
    end if;
  elsif new.expired_at is not null or new.expired_by is not null or new.expiry_outcome is not null then
    if new.expired_at is null or new.expired_by is null or new.expiry_outcome is null then
      raise exception 'Retention archive expiry needs expired_at, expired_by and expiry_outcome together' using errcode = '23514';
    end if;
    if new.completed_at is null or new.pruned_rows < new.row_count then
      raise exception 'A retention archive can expire only after every archived row was pruned from the source' using errcode = '23514';
    end if;
    if new.pruned_rows is distinct from old.pruned_rows then
      raise exception 'Recording the expiry of a retention archive cannot change anything else' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
`,
};
