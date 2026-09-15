-- An app may have at most one live invitation for a normalized address.
-- Existing duplicates must be reconciled by an operator before this migration
-- can apply; silently choosing one would discard a bearer link.
create unique index if not exists app_invites_pending_email
  on hosted.app_invites (app_id, lower(email)) where state = 'pending';

-- Keep the runtime's read-only authority check in sync with the DDL. The
-- insert is in the same migration transaction, so a duplicate legacy row
-- prevents both the index and the version marker from being recorded.
insert into hosted.schema_migrations (version, name, applied_at)
values (
  3,
  'one-pending-invite-per-app-email',
  to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
on conflict (version) do nothing;
