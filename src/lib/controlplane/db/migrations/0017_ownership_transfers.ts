/**
 * Approved field-ownership transfers (PROD-LIFE-12). A row exists only because a
 * human approved the exact operation proposal that named this transfer digest;
 * it is bound to that operation's immutable proposal digest and approval id.
 * Rows are append-only apart from one-way revocation.
 */
export const migration0017OwnershipTransfers = {
  version: 17,
  name: "ownership_transfers",
  sql: `
create table if not exists platform.ownership_transfers (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  address          text        not null check (length(address) between 1 and 500),
  resource_type    text        not null check (length(resource_type) between 1 and 200),
  field_path       text        not null check (length(field_path) between 1 and 500),
  from_owner       text        not null check (from_owner in ('iac','native-op','autoscaler')),
  to_owner         text        not null check (to_owner in ('iac','native-op','autoscaler') and to_owner <> from_owner),
  transfer_digest  text        not null check (transfer_digest ~ '^[0-9a-f]{64}$'),
  operation_id     text        not null,
  approval_id      text        not null references platform.approvals(id),
  proposal_digest  text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  approved_at      timestamptz not null,
  expires_at       timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id, transfer_digest),
  check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists ownership_transfers_env_address on platform.ownership_transfers (workspace_id, environment_id, address) where revoked_at is null;
create or replace function platform.ownership_transfer_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Ownership transfers cannot be deleted' using errcode = '23514';
  end if;
  if old.revoked_at is not null
     or new.revoked_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.address, new.resource_type, new.field_path, new.from_owner,
         new.to_owner, new.transfer_digest, new.operation_id, new.approval_id, new.proposal_digest, new.approved_at, new.expires_at, new.created_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.address, old.resource_type, old.field_path, old.from_owner,
         old.to_owner, old.transfer_digest, old.operation_id, old.approval_id, old.proposal_digest, old.approved_at, old.expires_at, old.created_at)
  then
    raise exception 'Ownership transfers can only be revoked, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists ownership_transfer_guard on platform.ownership_transfers;
create trigger ownership_transfer_guard before update or delete on platform.ownership_transfers
for each row execute function platform.ownership_transfer_guard();
alter table platform.ownership_transfers enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.ownership_transfers from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.ownership_transfers from service_role;
    grant select,insert on table platform.ownership_transfers to service_role;
    grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
  end if;
end
$$;
`,
} as const;
