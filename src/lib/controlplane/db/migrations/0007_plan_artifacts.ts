/** Ciphertext is an internal artifact authority, separate from sanitized evidence. No pruning policy is introduced. */
export const migration0007PlanArtifacts = {
  version: 7,
  name: "plan_artifacts",
  sql: `
create table if not exists platform.plan_artifacts (
  workspace_id text not null,
  operation_id text not null,
  manifest jsonb not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv) = 16),
  auth_tag text not null check (length(auth_tag) = 24),
  ciphertext text not null check (length(ciphertext) between 1 and 30000000),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (manifest->>'workspaceId' = workspace_id and manifest->>'operationId' = operation_id and manifest->>'planDigest' = plan_digest)
);
create table if not exists platform.plan_artifact_associations (
  workspace_id text not null,
  operation_id text not null,
  source_operation_id text not null,
  source_evidence_id text not null,
  source_manifest_digest text not null,
  source_raw_sha256 text not null,
  proposal_digest text not null,
  input_digest text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, source_operation_id) references platform.plan_artifacts (workspace_id, operation_id),
  check (operation_id <> source_operation_id)
);
create table if not exists platform.plan_artifact_uses (
  workspace_id text not null,
  operation_id text not null,
  phase text not null default 'ready' check (phase in ('ready','claimed','dispatched','succeeded','uncertain','expired')),
  attempt_id text,
  holder text,
  fence_token bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create or replace function platform.immutable_plan_artifact() returns trigger language plpgsql as $$
begin
  raise exception 'Immutable plan artifact cannot be modified or deleted' using errcode = '23514';
end
$$;
drop trigger if exists immutable_plan_artifact on platform.plan_artifacts;
create trigger immutable_plan_artifact before update or delete on platform.plan_artifacts
for each row execute function platform.immutable_plan_artifact();
drop trigger if exists immutable_plan_artifact_association on platform.plan_artifact_associations;
create trigger immutable_plan_artifact_association before update or delete on platform.plan_artifact_associations
for each row execute function platform.immutable_plan_artifact();
create index if not exists plan_artifacts_expiry on platform.plan_artifacts (expires_at);
-- Canonical schema-6 upgrades may use a different migration owner from the emitted bootstrap.
-- Harden only these new authority tables; existing/custom role policy remains operator-owned.
alter table platform.plan_artifacts enable row level security;
alter table platform.plan_artifact_associations enable row level security;
alter table platform.plan_artifact_uses enable row level security;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses to service_role;
  end if;
end
$$;

`,
} as const;
