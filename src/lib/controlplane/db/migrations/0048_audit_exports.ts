/**
 * Tamper-evident audit export ledger (PROD-OPS-09).
 *
 * `audit_exports` is workspace-owned and append-only: one row per signed, hash-chained export of a range of a
 * workspace's audit log. The export document itself (the events) is handed to the operator and never stored here; the
 * row keeps only what lets a later verifier detect a swapped, shortened or re-ordered export: the chain `genesis` and
 * `head`, the event count, the digest of the signed header, the signing key id and the link to the workspace's
 * previous export (`previous_export_id`, `previous_head`). The links form one linear chain per workspace (a partial
 * unique index refuses two exports with the same predecessor), so an export that was dropped from the middle shows up
 * as a head that no later export points at. Update and delete are refused by trigger.
 *
 * No event content, input value or secret is stored; `created_by` is the principal id of the admin who requested it.
 */
export const migration0048AuditExports = {
  version: 48,
  name: "audit_exports",
  sql: `
create table if not exists platform.audit_exports (
  seq                bigint generated always as identity,
  id                 text        not null primary key check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  workspace_id       text        not null check (char_length(workspace_id) between 1 and 128),
  range_from         timestamptz,
  range_to           timestamptz,
  event_count        integer     not null check (event_count >= 0),
  genesis            text        not null check (genesis ~ '^[0-9a-f]{64}$'),
  head               text        not null check (head ~ '^[0-9a-f]{64}$'),
  previous_export_id text,
  previous_head      text        check (previous_head is null or previous_head ~ '^[0-9a-f]{64}$'),
  key_id             text        not null check (char_length(key_id) between 1 and 200),
  signature_digest   text        not null check (signature_digest ~ '^[0-9a-f]{64}$'),
  created_by         text        not null check (char_length(created_by) between 1 and 200),
  created_at         timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  foreign key (workspace_id, previous_export_id) references platform.audit_exports (workspace_id, id),
  check ((previous_export_id is null) = (previous_head is null)),
  check (range_from is null or range_to is null or range_from <= range_to)
);
create unique index if not exists audit_exports_one_successor on platform.audit_exports (workspace_id, previous_export_id) where previous_export_id is not null;
create unique index if not exists audit_exports_one_root on platform.audit_exports (workspace_id) where previous_export_id is null;
create index if not exists audit_exports_ws on platform.audit_exports (workspace_id, seq desc);

create or replace function platform.audit_exports_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Audit export records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists audit_exports_immutable on platform.audit_exports;
create trigger audit_exports_immutable before update or delete on platform.audit_exports
for each row execute function platform.audit_exports_immutable();

alter table platform.audit_exports enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.audit_exports from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.audit_exports from service_role;
    grant select,insert on table platform.audit_exports to service_role;
  end if;
end
$$;
`,
} as const;
