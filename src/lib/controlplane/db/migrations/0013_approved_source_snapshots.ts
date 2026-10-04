/** Permanent approved-input records. No expiry, pruning or delete policy. */
export const migration0013ApprovedSourceSnapshots = {
  version: 13,
  name: "approved_source_snapshots",
  sql: `
create table if not exists platform.approved_source_snapshots (
  workspace_id text not null,
  operation_id text not null,
  project_id text not null,
  environment_id text not null,
  service_address text not null check (service_address ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=16000),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,operation_id,service_address),
  foreign key (workspace_id,operation_id) references platform.operations(workspace_id,id),
  check ((snapshot ?& array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']
    and snapshot - array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']='{}'::jsonb
    and jsonb_typeof(snapshot->'format')='string'
    and jsonb_typeof(snapshot->'workspaceId')='string'
    and jsonb_typeof(snapshot->'operationId')='string'
    and jsonb_typeof(snapshot->'projectId')='string'
    and jsonb_typeof(snapshot->'environmentId')='string'
    and jsonb_typeof(snapshot->'serviceAddress')='string'
    and jsonb_typeof(snapshot->'serviceSpecDigest')='string'
    and jsonb_typeof(snapshot->'pipelineAddress')='string'
    and jsonb_typeof(snapshot->'pipelineSpecDigest')='string'
    and jsonb_typeof(snapshot->'provider')='string'
    and jsonb_typeof(snapshot->'region')='string'
    and jsonb_typeof(snapshot->'owner')='string'
    and jsonb_typeof(snapshot->'repo')='string'
    and jsonb_typeof(snapshot->'requestedRef')='string'
    and jsonb_typeof(snapshot->'commitSha')='string'
    and jsonb_typeof(snapshot->'dockerfile')='string'
    and jsonb_typeof(snapshot->'dockerfileDigest')='string'
    and jsonb_typeof(snapshot->'recipeDigest')='string'
    and jsonb_typeof(snapshot->'archiveFormat')='string'
    and jsonb_typeof(snapshot->'archiveDigest')='string'
    and snapshot->>'format'='zenith.approved-source.v1'
    and workspace_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and operation_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and project_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and environment_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and snapshot->>'workspaceId'=workspace_id and snapshot->>'operationId'=operation_id
    and snapshot->>'projectId'=project_id and snapshot->>'environmentId'=environment_id
    and snapshot->>'serviceAddress'=service_address
    and snapshot->>'commitSha' ~ '^[a-f0-9]{40}$'
    and snapshot->>'archiveDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'dockerfileDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'recipeDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'serviceSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'pipelineSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'provider' in ('aws','gcp','azure')
    and snapshot->>'archiveFormat'=case when snapshot->>'provider'='aws' then 'zip' else 'tar.gz' end
    and jsonb_typeof(snapshot->'repositoryId')='number'
    and (snapshot->>'repositoryId')::numeric between 1 and 9007199254740991
    and jsonb_typeof(snapshot->'archiveBytes')='number'
    and (snapshot->>'archiveBytes')::numeric between 1 and 33554432
    and snapshot->>'repositoryId' ~ '^[1-9][0-9]{0,15}$' and snapshot->>'archiveBytes' ~ '^[1-9][0-9]{0,7}$'
    and snapshot->>'pipelineAddress' ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'
    and snapshot->>'owner' ~ '^[a-z0-9][a-z0-9-]{0,38}$' and snapshot->>'repo' ~ '^[a-z0-9._-]{1,100}$' and snapshot->>'repo' not in ('.','..')
    and snapshot->>'region' ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and length(snapshot->>'requestedRef') between 1 and 250 and snapshot->>'requestedRef' ~ '^[A-Za-z0-9._+@~-]{1,100}(/[A-Za-z0-9._+@~-]{1,100})*$'
    and snapshot->>'requestedRef' !~ '(^|/)[.]{1,2}(/|$)'
    and length(snapshot->>'dockerfile') between 1 and 200 and snapshot->>'dockerfile' ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
    and position('..' in snapshot->>'dockerfile')=0 and snapshot->>'dockerfile' !~ '(^|/)[.](/|$)'
    and (snapshot->'githubBinding'='null'::jsonb or (
      jsonb_typeof(snapshot->'githubBinding')='object'
      and snapshot->'githubBinding' ?& array['appId','installationId','repositoryId','version']
      and (snapshot->'githubBinding') - array['appId','installationId','repositoryId','version']='{}'::jsonb
      and jsonb_typeof(snapshot->'githubBinding'->'appId')='string' and snapshot->'githubBinding'->>'appId' ~ '^[1-9][0-9]{0,15}$'
      and jsonb_typeof(snapshot->'githubBinding'->'installationId')='number' and snapshot->'githubBinding'->>'installationId' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'installationId')::numeric<=9007199254740991
      and snapshot->'githubBinding'->'repositoryId'=snapshot->'repositoryId'
      and jsonb_typeof(snapshot->'githubBinding'->'version')='number' and snapshot->'githubBinding'->>'version' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'version')::numeric<=9007199254740991
    ))) is true)
);
create or replace function platform.retain_approved_source_snapshot() returns trigger language plpgsql as $$
begin
  if TG_OP='TRUNCATE' or TG_OP='DELETE' or (TG_OP='UPDATE' and new is distinct from old) then
    raise exception 'Approved source records are immutable' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists retain_approved_source_snapshot on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot before update or delete on platform.approved_source_snapshots
for each row execute function platform.retain_approved_source_snapshot();
drop trigger if exists retain_approved_source_snapshot_truncate on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot_truncate before truncate on platform.approved_source_snapshots
for each statement execute function platform.retain_approved_source_snapshot();
alter table platform.approved_source_snapshots enable row level security;
revoke all on platform.approved_source_snapshots from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.approved_source_snapshots from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on platform.approved_source_snapshots from service_role;
    grant select,insert on platform.approved_source_snapshots to service_role;
  end if;
end $$;
`,
} as const;
