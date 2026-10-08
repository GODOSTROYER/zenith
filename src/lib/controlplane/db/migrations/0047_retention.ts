/**
 * Configurable non-destructive retention (PROD-OPS-07).
 *
 * `legal_holds`: tenant-scoped holds that block archive-then-delete and pruning. A hold names a workspace, and optionally
 * one data class, one resource (a job, request, resource, environment or operation id) and a time range over the row's
 * recorded time. Holds are never deleted; the only change after creation is a one-way release.
 *
 * `retention_archives`: one row per archive batch that was copied to object storage AND read back and digest-verified
 * (the row is inserted only after the readback matched). It records where the copy lives, the rows digest, the row-id
 * range and how much of the source has since been pruned. Identity columns are immutable; rows are never deleted.
 * The archive object itself (sealed rows) lives in operator/tenant object storage, never in this database. `destination_id`
 * is null for the operator's bucket and names the `retention_destinations` row for a tenant-owned bucket.
 *
 * `retention_destinations`: a workspace's own archive bucket, expressed the LIFE-11 way (an object_store resource of one of
 * its environments plus a vault credentials reference, resolved through the brokered secret path at use). At most one
 * active per workspace; the only change after creation is a one-way revoke. No secret is stored here.
 *
 * `retention_restores`: append-only audit of every archive restore attempt (who, what, how many rows, verdict).
 */
export const migration0047Retention = {
  version: 47,
  name: "retention",
  sql: `
create table if not exists platform.legal_holds (
  id             text        not null primary key,
  workspace_id   text        not null,
  data_class     text        check (data_class is null or data_class in ('runner_job_logs','machine_request_logs','resource_observations','drift_reports')),
  resource_ref   text        check (resource_ref is null or char_length(resource_ref) between 1 and 200),
  time_from      timestamptz,
  time_to        timestamptz,
  reason         text        not null check (char_length(reason) between 1 and 500),
  created_by     text        not null check (char_length(created_by) between 1 and 128),
  created_at     timestamptz not null default clock_timestamp(),
  released_at    timestamptz,
  released_by    text,
  release_reason text        check (release_reason is null or char_length(release_reason) <= 500),
  check (time_from is null or time_to is null or time_to >= time_from),
  check ((released_at is null and released_by is null) or (released_at is not null and released_by is not null))
);
create index if not exists legal_holds_active on platform.legal_holds (workspace_id) where released_at is null;

create or replace function platform.legal_holds_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Legal holds are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.data_class, new.resource_ref, new.time_from, new.time_to, new.reason, new.created_by, new.created_at)
     is distinct from (old.id, old.workspace_id, old.data_class, old.resource_ref, old.time_from, old.time_to, old.reason, old.created_by, old.created_at) then
    raise exception 'A legal hold can only be released, not edited' using errcode = '23514';
  end if;
  if old.released_at is not null then
    raise exception 'A released legal hold stays released' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists legal_holds_guard on platform.legal_holds;
create trigger legal_holds_guard before update or delete on platform.legal_holds
for each row execute function platform.legal_holds_guard();

create table if not exists platform.retention_archives (
  id                  text        not null primary key,
  workspace_id        text        not null,
  data_class          text        not null check (data_class in ('runner_job_logs','machine_request_logs','resource_observations','drift_reports')),
  object_key          text        not null check (char_length(object_key) <= 512),
  rows_digest         text        not null check (rows_digest ~ '^[0-9a-f]{64}$'),
  row_count           integer     not null check (row_count >= 1),
  first_row_id        text        not null,
  last_row_id         text        not null,
  last_recorded_at    timestamptz not null,
  key_id              text        not null,
  destination_id      text,
  destination_label   text        not null default 'operator storage',
  policy_digest      text        not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default clock_timestamp(),
  verified_at         timestamptz not null default clock_timestamp(),
  pruned_rows         integer     not null default 0 check (pruned_rows >= 0),
  completed_at        timestamptz,
  next_prune_check_at timestamptz,
  unique (workspace_id, data_class, object_key)
);
create index if not exists retention_archives_ws_class on platform.retention_archives (workspace_id, data_class, last_recorded_at desc);
create index if not exists retention_archives_pending on platform.retention_archives (next_prune_check_at) where completed_at is null;

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
  return new;
end
$$;
drop trigger if exists retention_archives_guard on platform.retention_archives;
create trigger retention_archives_guard before update or delete on platform.retention_archives
for each row execute function platform.retention_archives_guard();

create table if not exists platform.retention_destinations (
  id               text        not null primary key,
  workspace_id     text        not null,
  environment_id   text        not null,
  resource_address text        not null check (char_length(resource_address) between 1 and 300),
  credentials_ref  text        not null check (char_length(credentials_ref) between 1 and 1024),
  bucket           text        not null check (char_length(bucket) between 3 and 63),
  created_by       text        not null,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);
create unique index if not exists retention_destinations_active on platform.retention_destinations (workspace_id) where revoked_at is null;

create or replace function platform.retention_destinations_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Retention destinations are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.environment_id, new.resource_address, new.credentials_ref, new.bucket, new.created_by, new.created_at)
     is distinct from (old.id, old.workspace_id, old.environment_id, old.resource_address, old.credentials_ref, old.bucket, old.created_by, old.created_at)
     or old.revoked_at is not null then
    raise exception 'A retention destination can only be revoked, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retention_destinations_guard on platform.retention_destinations;
create trigger retention_destinations_guard before update or delete on platform.retention_destinations
for each row execute function platform.retention_destinations_guard();

create table if not exists platform.retention_restores (
  id                      text        not null primary key,
  workspace_id            text        not null,
  archive_id              text        not null references platform.retention_archives (id),
  data_class              text        not null,
  mode                    text        not null check (mode in ('staging','source','verify')),
  staging_schema          text,
  requested_by            text        not null,
  rows_selected           integer     not null default 0,
  rows_inserted           integer     not null default 0,
  rows_existing_identical integer     not null default 0,
  rows_existing_differ    integer     not null default 0,
  rows_skipped_no_parent  integer     not null default 0,
  verdict                 text        not null check (verdict in ('verified','mismatch','refused')),
  detail                  text,
  created_at              timestamptz not null default clock_timestamp()
);
create index if not exists retention_restores_workspace on platform.retention_restores (workspace_id, created_at desc);
create index if not exists retention_restores_archive on platform.retention_restores (archive_id, created_at desc);

create or replace function platform.retention_restores_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Retention restore records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists retention_restores_immutable on platform.retention_restores;
create trigger retention_restores_immutable before update or delete on platform.retention_restores
for each row execute function platform.retention_restores_immutable();

alter table platform.legal_holds enable row level security;
alter table platform.retention_archives enable row level security;
alter table platform.retention_destinations enable row level security;
alter table platform.retention_restores enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['legal_holds','retention_archives','retention_destinations','retention_restores'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke delete, truncate on table platform.%I from service_role', t);
    end if;
  end loop;
end $$;
`,
};
