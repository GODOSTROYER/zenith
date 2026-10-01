/**
 * Migration 6 — tenant-scoped GitHub App bindings and expiring install intents.
 * Frozen, additive DDL: previously installed source tables and rows are retained.
 * Every primary key starts with workspace_id; credentials are never stored.
 * Future source-schema changes require a new platform migration.
 */
export const migration0006GithubSources = {
  version: 6,
  name: "github_sources",
  sql: `
create table if not exists platform.github_source_bindings (
  workspace_id text primary key,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  version integer not null check (version > 0),
  bound_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.github_install_intents (
  workspace_id text not null,
  state_digest text not null check (state_digest ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  browser_digest text not null check (browser_digest ~ '^[a-f0-9]{64}$'),
  owner text not null,
  repo text not null,
  expected_version integer not null check (expected_version >= 0),
  installation_id bigint,
  phase text not null check (phase in ('install', 'oauth')),
  expires_at timestamptz not null,
  primary key (workspace_id, state_digest)
);
`,
} as const;
