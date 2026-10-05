/**
 * PROD-LIFE-08: record WHY a GitHub source binding stopped granting access
 * (explicit unbind vs installation deleted/suspended vs repository removed).
 * Additive and nullable: historical revocations keep a null reason. The reason is
 * descriptive only; revoked_at remains the single authority bit.
 */
export const migration0027GithubRevocationReason = {
  version: 27,
  name: "github_revocation_reason",
  sql: `
alter table platform.github_source_bindings add column if not exists revoked_reason text
  check (revoked_reason is null or revoked_reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));
alter table platform.github_binding_events add column if not exists reason text
  check (reason is null or reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));
`,
} as const;
