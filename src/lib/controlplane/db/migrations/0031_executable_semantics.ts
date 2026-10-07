/**
 * Executable semantics binding and bounded standing grants (PROD-DUR-03, PROD-DUR-04).
 *
 * `approved_semantics`: the canonical executable-semantics digest (and its component digests) the
 * reviewer was shown for one operation's saved plan. Write-once per (workspace, operation, plan
 * digest); a trigger refuses any update or delete. The approval flow compares what the person
 * reviewed with this row and every dispatch point recomputes the semantics and compares with it.
 * Only digests and short component names are stored, never a value of the configuration.
 *
 * `standing_grants`: a human administrator's explicit pre-approval for a class of repeat agent
 * operations. Scope (environment), capability list, risk ceiling, allowed agent principals, use
 * count and expiry are all NOT NULL and constrained here as well as in code. Identity and bound
 * columns are immutable (trigger); only `uses` (monotonic, never above `max_uses`) and the
 * one-way revocation can change. A use is reserved with a single guarded UPDATE, so concurrent
 * callers can never exceed `max_uses`.
 *
 * `standing_grant_uses`: one row per operation a grant approved. The approval id is attached once;
 * a use can be voided only while no approval is attached (the reserved count is returned).
 */
export const migration0031ExecutableSemantics = {
  version: 31,
  name: "executable_semantics",
  sql: `
create table if not exists platform.approved_semantics (
  workspace_id     text        not null,
  operation_id     text        not null,
  plan_digest      text        not null check (plan_digest ~ '^[0-9a-f]{64}$'),
  semantics_digest text        not null check (semantics_digest ~ '^[0-9a-f]{64}$'),
  semantics        jsonb       not null,
  created_at       timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, plan_digest),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (semantics->>'digest' = semantics_digest)
);

create or replace function platform.approved_semantics_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Approved executable semantics are write-once' using errcode = '23514';
end
$$;
drop trigger if exists approved_semantics_immutable on platform.approved_semantics;
create trigger approved_semantics_immutable before update or delete on platform.approved_semantics
for each row execute function platform.approved_semantics_immutable();

create table if not exists platform.standing_grants (
  id                 text        not null primary key,
  workspace_id       text        not null,
  created_by         text        not null check (length(created_by) between 1 and 200),
  created_by_name    text        not null check (length(created_by_name) between 1 and 200),
  project_id         text,
  environment_id     text        not null,
  resource_id        text,
  capabilities       jsonb       not null check (jsonb_typeof(capabilities) = 'array' and jsonb_array_length(capabilities) between 1 and 20),
  max_risk           text        not null check (max_risk in ('low','medium','high')),
  allowed_principals jsonb       not null check (jsonb_typeof(allowed_principals) = 'array' and jsonb_array_length(allowed_principals) between 1 and 20),
  max_uses           integer     not null check (max_uses between 1 and 1000),
  uses               integer     not null default 0 check (uses >= 0),
  expires_at         timestamptz not null,
  created_at         timestamptz not null,
  status             text        not null default 'active' check (status in ('active','revoked')),
  revoked_at         timestamptz,
  revoked_by         text,
  revoked_reason     text        check (revoked_reason is null or length(revoked_reason) <= 300),
  unique (workspace_id, id),
  check (uses <= max_uses),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index if not exists standing_grants_env on platform.standing_grants (workspace_id, environment_id, created_at);

create table if not exists platform.standing_grant_uses (
  id            text        not null primary key,
  workspace_id  text        not null,
  grant_id      text        not null,
  operation_id  text        not null,
  principal_key text        not null check (length(principal_key) between 3 and 300),
  approval_id   text,
  created_at    timestamptz not null,
  voided_at     timestamptz,
  foreign key (workspace_id, grant_id) references platform.standing_grants (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create unique index if not exists standing_grant_uses_once on platform.standing_grant_uses (workspace_id, grant_id, operation_id) where voided_at is null;
create index if not exists standing_grant_uses_op on platform.standing_grant_uses (workspace_id, operation_id);

create or replace function platform.standing_grant_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Standing grants cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.created_by, new.created_by_name, new.project_id, new.environment_id, new.resource_id, new.capabilities,
      new.max_risk, new.allowed_principals, new.max_uses, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.created_by, old.created_by_name, old.project_id, old.environment_id, old.resource_id, old.capabilities,
      old.max_risk, old.allowed_principals, old.max_uses, old.expires_at, old.created_at) then
    raise exception 'A standing grant keeps the scope, capabilities, principals, count and expiry it was created with' using errcode = '23514';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'A revoked standing grant stays revoked' using errcode = '23514';
  end if;
  if new.uses > new.max_uses then
    raise exception 'A standing grant cannot be used more than its count' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists standing_grant_guard on platform.standing_grants;
create trigger standing_grant_guard before update or delete on platform.standing_grants
for each row execute function platform.standing_grant_guard();

create or replace function platform.standing_grant_use_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Standing grant uses cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.grant_id, new.operation_id, new.principal_key, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.grant_id, old.operation_id, old.principal_key, old.created_at) then
    raise exception 'A standing grant use is immutable' using errcode = '23514';
  end if;
  if old.approval_id is not null and new.approval_id is distinct from old.approval_id then
    raise exception 'The approval of a standing grant use is attached once' using errcode = '23514';
  end if;
  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'A voided standing grant use stays voided' using errcode = '23514';
  end if;
  if new.voided_at is not null and new.approval_id is not null then
    raise exception 'A use that produced an approval cannot be voided' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists standing_grant_use_guard on platform.standing_grant_uses;
create trigger standing_grant_use_guard before update or delete on platform.standing_grant_uses
for each row execute function platform.standing_grant_use_guard();

alter table platform.approved_semantics enable row level security;
alter table platform.standing_grants enable row level security;
alter table platform.standing_grant_uses enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from service_role;
    grant select,insert on table platform.approved_semantics to service_role;
    grant select,insert,update on table platform.standing_grants to service_role;
    grant select,insert,update on table platform.standing_grant_uses to service_role;
  end if;
end
$$;
`,
} as const;
