/**
 * Purpose-separated key custody records (PROD-OPS-05).
 *
 * `key_custody_keys` is system-level, not tenant data: one row per (purpose, key id) the control plane has
 * ever configured, holding only NON-SECRET facts (the purpose-bound key id, role, the configuration variable
 * name it came from, when it was first and last seen, and the operator's planned and actual retirement dates).
 * No key material, fingerprint of material or configuration value is ever stored. The first-seen time is what
 * makes key ages reportable without trusting anyone's memory.
 *
 * `key_rewrap_jobs` is workspace-owned: one durable, resumable re-wrap of a workspace's sealed rows under the
 * current key, run by the critical-maintenance schedule (job `key-rewrap`). It carries a keyset cursor and
 * counts only, never refs, row values or error text. At most one open job exists per (workspace, purpose).
 */
export const migration0039KeyCustody = {
  version: 39,
  name: "key_custody",
  sql: `
create table if not exists platform.key_custody_keys (
  purpose       text        not null check (purpose ~ '^(signing|enc|tls):[a-z0-9-]{1,40}$'),
  key_id        text        not null check (char_length(key_id) between 1 and 200),
  role          text        not null check (role in ('current','decrypt_only','verify_only')),
  source        text        not null check (char_length(source) between 1 and 120),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at  timestamptz not null default clock_timestamp(),
  retire_after  timestamptz,
  retired_at    timestamptz,
  retired_by    text check (retired_by is null or char_length(retired_by) between 1 and 200),
  primary key (purpose, key_id),
  check (retired_at is null or role <> 'current' or retired_by is not null)
);

create table if not exists platform.key_rewrap_jobs (
  id            text        not null primary key,
  workspace_id  text        not null check (char_length(workspace_id) between 1 and 128),
  purpose       text        not null check (purpose in ('enc:vault')),
  target_key_id text        not null check (char_length(target_key_id) between 1 and 200),
  status        text        not null default 'pending' check (status in ('pending','running','completed','failed','blocked','cancelled')),
  cursor_ref    text        not null default '',
  inspected     integer     not null default 0 check (inspected >= 0),
  rewrapped     integer     not null default 0 check (rewrapped >= 0),
  unchanged     integer     not null default 0 check (unchanged >= 0),
  batches       integer     not null default 0 check (batches >= 0),
  error_code    text        check (error_code is null or error_code ~ '^[a-z_]{1,64}$'),
  requested_by  text        not null check (char_length(requested_by) between 1 and 200),
  created_at    timestamptz not null default clock_timestamp(),
  started_at    timestamptz,
  updated_at    timestamptz not null default clock_timestamp(),
  finished_at   timestamptz,
  unique (workspace_id, id),
  check ((status in ('completed','failed','blocked','cancelled')) = (finished_at is not null))
);
create unique index if not exists key_rewrap_jobs_open on platform.key_rewrap_jobs (workspace_id, purpose) where status in ('pending','running');
create index if not exists key_rewrap_jobs_queue on platform.key_rewrap_jobs (status, created_at, id) where status in ('pending','running');
create index if not exists key_rewrap_jobs_ws on platform.key_rewrap_jobs (workspace_id, created_at desc);

alter table platform.key_custody_keys enable row level security;
alter table platform.key_rewrap_jobs enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['key_custody_keys','key_rewrap_jobs'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;
`,
} as const;
