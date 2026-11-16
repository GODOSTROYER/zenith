/**
 * PROD-DUR-01 / PROD-DUR-02. Two additive tables and one trigger:
 *
 *  - `operation_authority`: ONE versioned fence record per operation. The
 *    operations row stays the authority for state; this record gives every
 *    writer a monotonic `version` that the database bumps on every
 *    authority-relevant change (status, approval round, plan digest, workflow
 *    id, runner job, lease/fence). A writer holding a stale version cannot
 *    commit (`casTransition` in `src/lib/controlplane/authority`), and every
 *    UI/API projection is derived from this record plus the intent tables, never
 *    from a process-local lock or a product-store copy.
 *  - `durable_intents`: the outbox for effects that leave the database (a
 *    Temporal signal, a workflow-start recovery). Rows are written before the
 *    effect or adopted from authority state, carry a deterministic idempotency
 *    key, and are delivered by any worker under a fenced claim (`claim_epoch`).
 *    A holder whose claim was superseded cannot settle the row.
 */
export const migration0030DurableIntentAuthority = {
  version: 30,
  name: "durable_intent_authority",
  sql: `
create table if not exists platform.operation_authority (
  workspace_id text not null,
  operation_id text not null,
  version bigint not null default 1 check (version >= 1),
  status text not null,
  approval_round integer not null default 0,
  plan_digest text,
  workflow_id text,
  fence_token bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id) on delete cascade
);
create or replace function platform.operation_authority_sync() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
begin
  if TG_OP = 'INSERT' then
    insert into platform.operation_authority (workspace_id, operation_id, status, approval_round, plan_digest, workflow_id, fence_token)
    values (new.workspace_id, new.id, new.status, coalesce(new.approval_round, 0), new.plan_digest, new.workflow_id, new.fence_token)
    on conflict (workspace_id, operation_id) do nothing;
    return new;
  end if;
  if (new.status, new.approval_round, new.plan_digest, new.workflow_id, new.runner_job_id, new.fence_token,
      new.lease_scope, new.lease_holder, new.policy_decision_id)
     is distinct from
     (old.status, old.approval_round, old.plan_digest, old.workflow_id, old.runner_job_id, old.fence_token,
      old.lease_scope, old.lease_holder, old.policy_decision_id) then
    insert into platform.operation_authority (workspace_id, operation_id, version, status, approval_round, plan_digest, workflow_id, fence_token)
    values (new.workspace_id, new.id, 2, new.status, coalesce(new.approval_round, 0), new.plan_digest, new.workflow_id, new.fence_token)
    on conflict (workspace_id, operation_id) do update
      set version = platform.operation_authority.version + 1, status = excluded.status,
          approval_round = excluded.approval_round, plan_digest = excluded.plan_digest,
          workflow_id = excluded.workflow_id, fence_token = excluded.fence_token,
          updated_at = clock_timestamp();
  end if;
  return new;
end
$$;
drop trigger if exists operation_authority_sync on platform.operations;
create trigger operation_authority_sync after insert or update on platform.operations
for each row execute function platform.operation_authority_sync();
insert into platform.operation_authority (workspace_id, operation_id, status, approval_round, plan_digest, workflow_id, fence_token)
select workspace_id, id, status, coalesce(approval_round, 0), plan_digest, workflow_id, fence_token from platform.operations
on conflict (workspace_id, operation_id) do nothing;

create table if not exists platform.durable_intents (
  id text primary key check (id ~ '^di_[a-f0-9]{40}$'),
  workspace_id text not null,
  operation_id text not null,
  kind text not null check (kind in ('workflow_signal','workflow_start')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 4000),
  payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  authority_version bigint not null check (authority_version >= 0),
  state text not null default 'pending' check (state in ('pending','delivered','dead')),
  outcome text check (outcome in ('delivered','not_found','refused','exhausted','superseded')),
  claim_epoch bigint not null default 0 check (claim_epoch >= 0),
  claimed_by text,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (char_length(last_error_code) <= 64),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique (workspace_id, kind, idempotency_key),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id) on delete cascade,
  check ((state = 'pending' and outcome is null and settled_at is null)
      or (state <> 'pending' and outcome is not null and settled_at is not null))
);
create index if not exists durable_intents_due on platform.durable_intents (next_attempt_at) where state = 'pending';
create index if not exists durable_intents_operation on platform.durable_intents (workspace_id, operation_id);
create or replace function platform.durable_intent_guard() returns trigger language plpgsql as $$
begin
  if (new.id, new.workspace_id, new.operation_id, new.kind, new.idempotency_key, new.payload, new.payload_digest,
      new.authority_version, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.operation_id, old.kind, old.idempotency_key, old.payload, old.payload_digest,
      old.authority_version, old.created_at) then
    raise exception 'Durable intent identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'pending' and new is distinct from old then
    raise exception 'A settled durable intent cannot change' using errcode = '23514';
  end if;
  if new.claim_epoch < old.claim_epoch or new.attempts < old.attempts then
    raise exception 'Durable intent fences only move forward' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists durable_intent_guard on platform.durable_intents;
create trigger durable_intent_guard before update on platform.durable_intents
for each row execute function platform.durable_intent_guard();

alter table platform.operation_authority enable row level security;
alter table platform.durable_intents enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['operation_authority','durable_intents'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- The authority record is written only by the trigger; services read it.
    grant select on table platform.operation_authority to service_role;
    grant select, insert, update on table platform.durable_intents to service_role;
  end if;
end
$$;
`,
} as const;
