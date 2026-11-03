/** Keep stable grants/audit history when GitHub reuses a revoked repository name. */
export const migration0063GithubRepositoryNameHistory = {
  version: 63,
  name: "github_repository_name_history",
  sql: `
do $github_repository_name_history$
begin
if not exists(select 1 from platform.schema_migrations where version=63) then
alter table platform.github_source_bindings add column if not exists name_current boolean not null default true;
-- Historical rows remain addressable by binding/repository ID. Name lookup has
-- exactly one current row, including a revoked tombstone until explicit consent
-- replaces it. Active authority must always hold the current name.
alter table platform.github_source_bindings add constraint github_historical_name_revoked check(name_current or revoked_at is not null);
drop index if exists platform.github_bindings_tenant_name;
create unique index github_bindings_current_name on platform.github_source_bindings(workspace_id,owner,repo) where name_current;
-- OAuth consent captures both the target stable identity and the name it may
-- supersede. A later revoke/reconnect/rename cannot be overwritten by a callback.
alter table platform.github_install_intents add column if not exists expected_name_repository_id bigint check(expected_name_repository_id>0);
alter table platform.github_install_intents add column if not exists expected_name_version integer check(expected_name_version>0);
alter table platform.github_install_intents add constraint github_intent_name_snapshot check((expected_name_repository_id is null) = (expected_name_version is null));
end if;
end $github_repository_name_history$;
`,
} as const;
