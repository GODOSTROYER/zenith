/**
 * Reviewed, revocable plugin boundaries (PROD-UX-03).
 *
 *  - plugin_registrations: a verified, immutable manifest per workspace and the
 *    workspace admin's review decision (approved tools/scopes are a subset of
 *    the declared ones). `revoked` and `rejected` are terminal.
 *  - plugin_grants: audience-bound plugin tokens (only a sha256 hash is stored)
 *    attenuating one of the minting member's own linked credentials. Revoking a
 *    registration revokes every grant in the same transaction.
 *  - plugin_events: append-only audit trail.
 */
export const migration0028PluginBoundaries = {
  version: 28,
  name: "plugin_boundaries",
  sql: `
create table if not exists platform.plugin_registrations (
  id              text primary key,
  workspace_id    text not null,
  plugin_id       text not null,
  plugin_version  text not null,
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text not null check (artifact_digest ~ '^[0-9a-f]{64}$'),
  publisher_id    text not null,
  manifest        jsonb not null,
  provenance      jsonb not null,
  status          text not null check (status in ('pending_review','approved','rejected','revoked')),
  approved_tools  jsonb not null default '[]'::jsonb,
  approved_scopes jsonb not null default '[]'::jsonb,
  requested_by    text not null,
  reviewed_by     text,
  reviewed_at     timestamptz,
  revoked_by      text,
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, plugin_id, plugin_version)
);
create index if not exists plugin_registrations_ws on platform.plugin_registrations(workspace_id, created_at desc);
create table if not exists platform.plugin_grants (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null references platform.plugin_registrations(id),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  audience        text not null,
  credential_id   text not null,
  subject         text not null,
  scopes          jsonb not null,
  project_ids     jsonb not null,
  environment_ids jsonb,
  created_by      text not null,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_used_at    timestamptz
);
create index if not exists plugin_grants_registration on platform.plugin_grants(workspace_id, registration_id);
create table if not exists platform.plugin_events (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null,
  kind            text not null,
  actor           text not null,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists plugin_events_registration on platform.plugin_events(workspace_id, registration_id, created_at);
alter table platform.plugin_registrations enable row level security;
alter table platform.plugin_grants enable row level security;
alter table platform.plugin_events enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['plugin_registrations','plugin_grants','plugin_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      if t = 'plugin_events' then
        execute format('grant select,insert on table platform.%I to service_role',t);
      else
        execute format('grant select,insert,update on table platform.%I to service_role',t);
      end if;
    end if;
  end loop;
end
$$;
`,
} as const;
