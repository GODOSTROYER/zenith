/**
 * Release pipelines and migration approvals (PROD-LIFE-10).
 *
 * `release_runs` is one image digest moving through one service of one environment. The digest
 * and identity columns are immutable (trigger); state moves only forward through the allowed
 * transition table, enforced here as well as in code, with a version counter for compare-and-set.
 * `release_events` is append-only. `release_migration_approvals` rows are immutable except for the
 * one-way `consumed_at`, and the approver can never be the requester.
 * No credential, argv, SQL text or command output is stored: only digests and short scrubbed text.
 */
export const migration0024ReleasePipelines = {
  version: 24,
  name: "release_pipelines",
  sql: `
create table if not exists platform.release_runs (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  operation_id     text        not null,
  revision_id      text,
  requested_by     text        not null,
  service_address  text        not null check (length(service_address) between 1 and 500),
  kind             text        not null check (kind in ('deploy','rollback')),
  state            text        not null check (state in ('planned','built','verified','blocked_approval','deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified','failed','uncertain','rolled_back','refused')),
  image_uri        text        not null check (length(image_uri) between 1 and 500),
  image_digest     text        not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_digest    text,
  previous_digest  text        check (previous_digest is null or previous_digest ~ '^sha256:[0-9a-f]{64}$'),
  restores_run_id  text,
  provenance       jsonb       not null,
  migration        jsonb       not null,
  rollout          jsonb       not null,
  readback         jsonb,
  reason           text        check (reason is null or length(reason) <= 600),
  version          integer     not null default 1 check (version >= 1),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  unique (workspace_id, operation_id, service_address, kind),
  unique (workspace_id, id)
);
create index if not exists release_runs_env_service on platform.release_runs (workspace_id, environment_id, service_address, created_at desc);
create index if not exists release_runs_revision on platform.release_runs (workspace_id, environment_id, service_address, revision_id) where revision_id is not null;
create index if not exists release_runs_digest on platform.release_runs (workspace_id, environment_id, service_address, image_digest);

create table if not exists platform.release_events (
  workspace_id text        not null,
  run_id       text        not null,
  seq          integer     not null check (seq >= 1),
  from_state   text,
  to_state     text        not null,
  detail       text        not null check (length(detail) <= 600),
  actor        text        not null check (length(actor) <= 200),
  created_at   timestamptz not null default clock_timestamp(),
  primary key (workspace_id, run_id, seq),
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id)
);

create table if not exists platform.release_migration_approvals (
  id              text        not null primary key,
  workspace_id    text        not null,
  run_id          text        not null,
  binding_digest  text        not null check (binding_digest ~ '^[0-9a-f]{64}$'),
  class           text        not null check (class in ('data','contract','unclassified')),
  approved_by     text        not null,
  requested_by    text        not null,
  approved_at     timestamptz not null,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id),
  unique (workspace_id, run_id, binding_digest),
  check (approved_by <> requested_by),
  check (expires_at > approved_at)
);
create index if not exists release_migration_approvals_binding on platform.release_migration_approvals (workspace_id, binding_digest, approved_at desc);

create or replace function platform.release_run_guard() returns trigger language plpgsql as $$
declare allowed text[];
begin
  if tg_op = 'DELETE' then
    raise exception 'Release runs cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.project_id, new.environment_id, new.operation_id, new.revision_id, new.requested_by, new.service_address, new.kind,
      new.image_digest, new.source_digest, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.project_id, old.environment_id, old.operation_id, old.revision_id, old.requested_by, old.service_address, old.kind,
      old.image_digest, old.source_digest, old.created_at) then
    raise exception 'A release is bound to its image digest and identity; they cannot change' using errcode = '23514';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Release version must advance by one' using errcode = '23514';
  end if;
  allowed := case old.state
    when 'planned' then array['built','failed','uncertain','refused']
    when 'built' then array['verified','failed','uncertain','refused']
    when 'verified' then array['verified','blocked_approval','deployed','failed','uncertain','refused']
    when 'blocked_approval' then array['blocked_approval','verified','failed','uncertain','refused']
    when 'deployed' then array['deployed','migrated','rolled_back','failed','uncertain','refused']
    when 'migrated' then array['ready','rolled_back','failed','uncertain','refused']
    when 'ready' then array['cut_over','rolled_back','failed','uncertain','refused']
    when 'cut_over' then array['readback_verified','cut_over_unverified','rolled_back','failed','uncertain','refused']
    when 'readback_verified' then array['rolled_back']
    when 'cut_over_unverified' then array['rolled_back']
    when 'uncertain' then array['rolled_back','failed']
    else array[]::text[]
  end;
  if not (new.state = any(allowed)) then
    raise exception 'A release cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  if new.state in ('deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified')
     and (new.provenance->>'level' is null or new.provenance->>'level' = 'none') then
    raise exception 'A release cannot be deployed without verified provenance' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_run_guard on platform.release_runs;
create trigger release_run_guard before update or delete on platform.release_runs
for each row execute function platform.release_run_guard();

create or replace function platform.release_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Release events are append-only' using errcode = '23514';
end
$$;
drop trigger if exists release_events_append_only on platform.release_events;
create trigger release_events_append_only before update or delete on platform.release_events
for each row execute function platform.release_append_only();

create or replace function platform.release_approval_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Migration approvals cannot be deleted' using errcode = '23514';
  end if;
  if old.consumed_at is not null
     or new.consumed_at is null
     or (new.id, new.workspace_id, new.run_id, new.binding_digest, new.class, new.approved_by, new.requested_by, new.approved_at, new.expires_at)
        is distinct from
        (old.id, old.workspace_id, old.run_id, old.binding_digest, old.class, old.approved_by, old.requested_by, old.approved_at, old.expires_at) then
    raise exception 'A migration approval can only be consumed, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_approval_guard on platform.release_migration_approvals;
create trigger release_approval_guard before update or delete on platform.release_migration_approvals
for each row execute function platform.release_approval_guard();

alter table platform.release_runs enable row level security;
alter table platform.release_events enable row level security;
alter table platform.release_migration_approvals enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from service_role;
    grant select,insert,update on table platform.release_runs to service_role;
    grant select,insert on table platform.release_events to service_role;
    grant select,insert on table platform.release_migration_approvals to service_role;
    grant update (consumed_at) on table platform.release_migration_approvals to service_role;
  end if;
end
$$;
`,
} as const;
