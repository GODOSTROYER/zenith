/**
 * Data-service portability (PROD-LIFE-11): verified exports, verified restores
 * and ownership claims.
 *
 *   portability_exports   one row per export whose artifact was read back from
 *                         tenant storage and verified; append-only
 *   portability_restores  one row per restore with the readback verdict taken
 *                         from the target itself; append-only
 *   resource_adoptions    a human-approved ownership claim over an existing
 *                         object, with the field owners and drift baseline at the
 *                         moment of adoption; one-way release, never edited
 *
 * No secret is ever stored: destinations are labels, credentials are vault refs
 * resolved by the worker at call time.
 */
export const migration0025Portability = {
  version: 25,
  name: "portability",
  sql: `
create table if not exists platform.portability_exports (
  id                text        not null primary key,
  workspace_id      text        not null,
  project_id        text,
  environment_id    text        not null,
  operation_id      text        not null,
  resource_id       text        not null,
  address           text        not null check (length(address) between 1 and 500),
  kind              text        not null check (kind in ('postgres','mysql','object_store')),
  provider          text        not null check (length(provider) between 1 and 60),
  engine            text        not null check (length(engine) between 1 and 60),
  engine_version    text        check (engine_version is null or length(engine_version) <= 200),
  destination_label text        not null check (length(destination_label) between 1 and 300),
  artifact_prefix   text        not null check (length(artifact_prefix) between 1 and 500),
  manifest_digest   text        not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  content_digest    text        not null check (content_digest ~ '^[0-9a-f]{64}$'),
  file_count        integer     not null check (file_count >= 0),
  byte_size         bigint      not null check (byte_size >= 0),
  coverage          jsonb       not null default '{}'::jsonb,
  verified_at       timestamptz not null,
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  unique (workspace_id, id)
);
create index if not exists portability_exports_env on platform.portability_exports (workspace_id, environment_id, created_at desc);

create table if not exists platform.portability_restores (
  id                      text        not null primary key,
  workspace_id            text        not null,
  project_id              text,
  environment_id          text        not null,
  operation_id            text        not null,
  export_id               text        not null,
  target_resource_id      text        not null,
  target_address          text        not null check (length(target_address) between 1 and 500),
  kind                    text        not null check (kind in ('postgres','mysql','object_store')),
  provider                text        not null check (length(provider) between 1 and 60),
  status                  text        not null check (status in ('verified','mismatch')),
  expected_content_digest text        not null check (expected_content_digest ~ '^[0-9a-f]{64}$'),
  observed_content_digest text        not null check (observed_content_digest ~ '^[0-9a-f]{64}$'),
  readback                jsonb       not null default '{}'::jsonb,
  restored                jsonb       not null default '{}'::jsonb,
  verified_at             timestamptz not null,
  created_at              timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, export_id) references platform.portability_exports (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'verified') = (expected_content_digest = observed_content_digest))
);
create index if not exists portability_restores_env on platform.portability_restores (workspace_id, environment_id, created_at desc);

create table if not exists platform.resource_adoptions (
  id                   text        not null primary key,
  workspace_id         text        not null,
  project_id           text,
  environment_id       text        not null,
  resource_id          text        not null,
  address              text        not null check (length(address) between 1 and 500),
  provider             text        not null check (length(provider) between 1 and 60),
  native_type          text        not null check (length(native_type) between 1 and 200),
  external_id          text        not null check (length(external_id) between 1 and 500),
  lifecycle            text        not null check (lifecycle in ('manage','manage_and_destroy')),
  claim                jsonb       not null,
  claim_digest         text        not null check (claim_digest ~ '^[0-9a-f]{64}$'),
  field_owners         jsonb       not null default '[]'::jsonb,
  baseline             jsonb       not null,
  baseline_digest      text        not null check (baseline_digest ~ '^[0-9a-f]{64}$'),
  operation_id         text        not null,
  approval_id          text        not null references platform.approvals(id),
  proposal_digest      text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  status               text        not null default 'active' check (status in ('active','released')),
  adopted_at           timestamptz not null default clock_timestamp(),
  released_at          timestamptz,
  released_by          text,
  release_operation_id text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'active') = (released_at is null)),
  check ((released_at is null) = (released_by is null))
);
create unique index if not exists resource_adoptions_active_object on platform.resource_adoptions (workspace_id, provider, native_type, external_id) where status = 'active';
create unique index if not exists resource_adoptions_active_address on platform.resource_adoptions (workspace_id, environment_id, address) where status = 'active';
create index if not exists resource_adoptions_env on platform.resource_adoptions (workspace_id, environment_id, adopted_at desc);

create or replace function platform.portability_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Portability records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists portability_exports_immutable on platform.portability_exports;
create trigger portability_exports_immutable before update or delete on platform.portability_exports
for each row execute function platform.portability_immutable();
drop trigger if exists portability_restores_immutable on platform.portability_restores;
create trigger portability_restores_immutable before update or delete on platform.portability_restores
for each row execute function platform.portability_immutable();

create or replace function platform.resource_adoption_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Adoption claims cannot be deleted' using errcode = '23514';
  end if;
  if old.status <> 'active'
     or new.status <> 'released'
     or new.released_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.resource_id, new.address, new.provider, new.native_type, new.external_id, new.lifecycle,
         new.claim, new.claim_digest, new.field_owners, new.baseline, new.baseline_digest, new.operation_id, new.approval_id, new.proposal_digest, new.adopted_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.resource_id, old.address, old.provider, old.native_type, old.external_id, old.lifecycle,
         old.claim, old.claim_digest, old.field_owners, old.baseline, old.baseline_digest, old.operation_id, old.approval_id, old.proposal_digest, old.adopted_at)
  then
    raise exception 'Adoption claims can only be released, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists resource_adoption_guard on platform.resource_adoptions;
create trigger resource_adoption_guard before update or delete on platform.resource_adoptions
for each row execute function platform.resource_adoption_guard();

alter table platform.portability_exports enable row level security;
alter table platform.portability_restores enable row level security;
alter table platform.resource_adoptions enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['portability_exports','portability_restores','resource_adoptions'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
      execute format('grant select,insert on table platform.%I to service_role', t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant update (status, released_at, released_by, release_operation_id) on table platform.resource_adoptions to service_role;
  end if;
end
$$;
`,
} as const;
