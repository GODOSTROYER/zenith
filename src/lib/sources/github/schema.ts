/**
 * Additive source-binding schema. Apply explicitly as an operator; runtime never
 * runs DDL. The platform migrator registry is outside this workstream's ownership.
 * Every tenant key and predicate includes workspace_id. No credentials are stored.
 */
import type { Sql } from "@/lib/controlplane/types";

export const GITHUB_SOURCE_SCHEMA_SQL = `
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
`;
export async function installGithubSourceSchema(db: Sql): Promise<void> {
  await db.tx(async (tx) => {
    for (const statement of GITHUB_SOURCE_SCHEMA_SQL.split(";").filter((part) => part.trim())) await tx.query(statement);
  });
}
