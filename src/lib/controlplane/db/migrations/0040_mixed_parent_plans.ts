/**
 * Parent and immutable child plans for mixed-cloud execution (PROD-MIX-01 / PROD-MIX-02).
 *
 *  - `mixed_parent_plans`   one immutable parent document (the ordered child set) plus a forward-only
 *                           execution status. The parent APPROVAL is not stored here: it is the ordinary
 *                           approval of the `parent_operation_id` operation, whose immutable proposal input
 *                           carries the child set digest.
 *  - `mixed_child_plans`    one row per child. The subplan columns are immutable. The child operation is bound
 *                           write-once; the state moves forward only, and a terminal child state needs a receipt.
 *  - `mixed_child_receipts` append-only, one terminal receipt per child. Never updated or deleted.
 *  - `mixed_addresses`      the stable-address registry of the plan; immutable, so a resume that derives
 *                           something else is detectable.
 *
 * Nothing here is credentials, plan files, provider responses or output values: ids, digests and bounded
 * JSON only.
 */
import type { PlatformMigration } from "./index";

export const migration0040MixedParentPlans: PlatformMigration = {
  version: 40,
  name: "mixed_parent_plans",
  sql: `
create table if not exists platform.mixed_parent_plans (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  plan_id text not null check (plan_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  project_id text not null check (project_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  parent_environment_id text not null check (parent_environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  format text not null check (format = 'zenith.mixed-parent-plan.v1'),
  graph_digest text not null check (graph_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  desired_digest text not null check (desired_digest ~ '^[a-f0-9]{64}$'),
  parent_digest text not null check (parent_digest ~ '^[a-f0-9]{64}$'),
  child_set_digest text not null check (child_set_digest ~ '^[a-f0-9]{64}$'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 900000),
  parent_operation_id text check (parent_operation_id is null or parent_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  status text not null default 'planned' check (status in ('planned','running','succeeded','failed','uncertain','cancelled')),
  created_by text not null check (char_length(created_by) between 1 and 200),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id),
  unique (workspace_id, parent_operation_id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (status = 'planned' or parent_operation_id is not null or status = 'cancelled')
);
create index if not exists mixed_parent_plans_environment on platform.mixed_parent_plans (workspace_id, parent_environment_id, created_at desc);

create table if not exists platform.mixed_child_plans (
  workspace_id text not null,
  plan_id text not null,
  partition_id text not null check (partition_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  ordinal integer not null check (ordinal >= 0 and ordinal < 64),
  child_environment_id text not null check (child_environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  connection_id text not null check (connection_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  provider text not null check (provider in ('aws','gcp','azure','oci')),
  account_id text not null check (char_length(account_id) between 1 and 300),
  region text not null check (region ~ '^[a-z0-9-]{3,40}$'),
  subplan_digest text not null check (subplan_digest ~ '^[a-f0-9]{64}$'),
  effect_digest text not null check (effect_digest ~ '^[a-f0-9]{64}$'),
  semantics_digest text not null check (semantics_digest ~ '^[a-f0-9]{64}$'),
  subplan jsonb not null check (jsonb_typeof(subplan) = 'object' and octet_length(subplan::text) <= 400000),
  child_operation_id text check (child_operation_id is null or child_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  executable_semantics_digest text check (executable_semantics_digest is null or executable_semantics_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending','adopted','started','succeeded','failed','uncertain','cancelled','blocked')),
  state_reason text check (state_reason is null or char_length(state_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, partition_id),
  unique (workspace_id, plan_id, ordinal),
  unique (workspace_id, child_operation_id),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, child_operation_id) references platform.operations (workspace_id, id),
  check ((state = 'pending') = (child_operation_id is null) or state = 'blocked')
);
create index if not exists mixed_child_plans_operation on platform.mixed_child_plans (workspace_id, child_operation_id) where child_operation_id is not null;

create table if not exists platform.mixed_child_receipts (
  workspace_id text not null,
  plan_id text not null,
  partition_id text not null,
  receipt_id text not null check (receipt_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  ordinal integer not null check (ordinal >= 0 and ordinal < 64),
  child_operation_id text not null check (child_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  outcome text not null check (outcome in ('succeeded','failed','uncertain','cancelled')),
  child_status text not null check (char_length(child_status) between 1 and 64),
  executable_semantics_digest text check (executable_semantics_digest is null or executable_semantics_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text check (plan_digest is null or plan_digest ~ '^[a-f0-9]{64}$'),
  outputs_digest text check (outputs_digest is null or outputs_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text not null check (receipt_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, partition_id),
  unique (workspace_id, receipt_id),
  foreign key (workspace_id, plan_id, partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id)
);

create table if not exists platform.mixed_addresses (
  workspace_id text not null,
  plan_id text not null,
  stable_address text not null check (char_length(stable_address) between 3 and 600),
  address text not null check (char_length(address) between 1 and 300),
  partition_id text not null,
  spec_digest text not null check (spec_digest ~ '^[a-f0-9]{64}$'),
  primary key (workspace_id, plan_id, stable_address),
  unique (workspace_id, plan_id, address),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, plan_id, partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id)
);

create or replace function platform.mixed_parent_plan_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Mixed parent plans are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.plan_id, new.project_id, new.parent_environment_id, new.format, new.graph_digest, new.manifest_digest,
      new.desired_digest, new.parent_digest, new.child_set_digest, new.plan, new.created_by, new.created_at)
     is distinct from
     (old.workspace_id, old.plan_id, old.project_id, old.parent_environment_id, old.format, old.graph_digest, old.manifest_digest,
      old.desired_digest, old.parent_digest, old.child_set_digest, old.plan, old.created_by, old.created_at) then
    raise exception using errcode = '23514', message = 'A mixed parent plan is immutable';
  end if;
  if old.parent_operation_id is not null and new.parent_operation_id is distinct from old.parent_operation_id then
    raise exception using errcode = '23514', message = 'The parent operation of a mixed plan is write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'Mixed parent plan updates must advance the version by one';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'planned' and new.status = 'running' and new.parent_operation_id is not null then null;
    elsif old.status = 'planned' and new.status = 'cancelled' then null;
    elsif old.status = 'running' and new.status in ('succeeded','failed','uncertain','cancelled') then null;
    else raise exception using errcode = '23514', message = 'Illegal mixed parent plan transition';
    end if;
  end if;
  new.updated_at = clock_timestamp();
  return new;
end $$;
drop trigger if exists mixed_parent_plan_guard on platform.mixed_parent_plans;
create trigger mixed_parent_plan_guard before update or delete on platform.mixed_parent_plans
  for each row execute function platform.mixed_parent_plan_guard();

create or replace function platform.mixed_child_plan_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Mixed child plans are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.plan_id, new.partition_id, new.ordinal, new.child_environment_id, new.connection_id, new.provider, new.account_id,
      new.region, new.subplan_digest, new.effect_digest, new.semantics_digest, new.subplan, new.created_at)
     is distinct from
     (old.workspace_id, old.plan_id, old.partition_id, old.ordinal, old.child_environment_id, old.connection_id, old.provider, old.account_id,
      old.region, old.subplan_digest, old.effect_digest, old.semantics_digest, old.subplan, old.created_at) then
    raise exception using errcode = '23514', message = 'A mixed child subplan is immutable';
  end if;
  if old.child_operation_id is not null and new.child_operation_id is distinct from old.child_operation_id then
    raise exception using errcode = '23514', message = 'The child operation of a mixed child is write-once';
  end if;
  if old.executable_semantics_digest is not null and new.executable_semantics_digest is distinct from old.executable_semantics_digest then
    raise exception using errcode = '23514', message = 'The executable semantics digest of a mixed child is write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'Mixed child plan updates must advance the version by one';
  end if;
  if old.state in ('succeeded','failed','uncertain','cancelled','blocked') and new.state is distinct from old.state then
    raise exception using errcode = '23514', message = 'A terminal mixed child cannot change state';
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending' and new.state = 'adopted' and new.child_operation_id is not null then null;
    elsif old.state in ('pending','adopted') and new.state = 'blocked' then null;
    elsif old.state = 'adopted' and new.state = 'started' then null;
    elsif old.state = 'started' and new.state in ('succeeded','failed','uncertain','cancelled')
          and exists (select 1 from platform.mixed_child_receipts r where r.workspace_id = old.workspace_id and r.plan_id = old.plan_id
            and r.partition_id = old.partition_id and r.outcome = new.state) then null;
    else raise exception using errcode = '23514', message = 'Illegal mixed child transition';
    end if;
  end if;
  new.updated_at = clock_timestamp();
  return new;
end $$;
drop trigger if exists mixed_child_plan_guard on platform.mixed_child_plans;
create trigger mixed_child_plan_guard before update or delete on platform.mixed_child_plans
  for each row execute function platform.mixed_child_plan_guard();

create or replace function platform.mixed_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Mixed receipts and addresses cannot be changed or removed';
end $$;
drop trigger if exists mixed_child_receipts_append_only on platform.mixed_child_receipts;
create trigger mixed_child_receipts_append_only before update or delete on platform.mixed_child_receipts
  for each row execute function platform.mixed_append_only();
drop trigger if exists mixed_addresses_append_only on platform.mixed_addresses;
create trigger mixed_addresses_append_only before update or delete on platform.mixed_addresses
  for each row execute function platform.mixed_append_only();

-- A receipt is only meaningful for a child that actually started, under the operation it started with.
create or replace function platform.mixed_child_receipt_guard() returns trigger language plpgsql as $$
declare c platform.mixed_child_plans%rowtype;
begin
  select * into c from platform.mixed_child_plans where workspace_id = new.workspace_id and plan_id = new.plan_id and partition_id = new.partition_id for share;
  if not found or c.state <> 'started' or c.child_operation_id is distinct from new.child_operation_id or c.ordinal <> new.ordinal then
    raise exception using errcode = '23514', message = 'A receipt needs a started child bound to the same operation';
  end if;
  return new;
end $$;
drop trigger if exists mixed_child_receipt_guard on platform.mixed_child_receipts;
create trigger mixed_child_receipt_guard before insert on platform.mixed_child_receipts
  for each row execute function platform.mixed_child_receipt_guard();

alter table platform.mixed_parent_plans enable row level security;
alter table platform.mixed_child_plans enable row level security;
alter table platform.mixed_child_receipts enable row level security;
alter table platform.mixed_addresses enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['mixed_parent_plans','mixed_child_plans','mixed_child_receipts','mixed_addresses'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    revoke all on table platform.mixed_parent_plans from service_role;
    revoke all on table platform.mixed_child_plans from service_role;
    revoke all on table platform.mixed_child_receipts from service_role;
    revoke all on table platform.mixed_addresses from service_role;
    grant select, insert, update on table platform.mixed_parent_plans to service_role;
    grant select, insert, update on table platform.mixed_child_plans to service_role;
    grant select, insert on table platform.mixed_child_receipts to service_role;
    grant select, insert on table platform.mixed_addresses to service_role;
  end if;
end $$;
`,
};
