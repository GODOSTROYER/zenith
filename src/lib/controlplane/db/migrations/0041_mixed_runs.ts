/**
 * Mixed-graph parent runs, their event ledger and output preauthorizations
 * (PROD-MIX-03, PROD-MIX-04).
 *
 * `mixed_runs`: one row per parent operation holding the orchestration state of its child
 * workflows (per-child status, effect knowledge, receipts, teardown proposal). It records what
 * happened; it never claims a transaction. Optimistic concurrency: `version` must increase by
 * exactly one per write (trigger), identity columns are immutable, rows are never deleted.
 * `open` and `next_deadline_at` let the housekeeping sweep find runs whose child timeout or
 * approval expiry has passed without scanning every run.
 *
 * `mixed_run_events`: append-only ledger, one row per state change (`seq` equals the new state's
 * `seq`). It stores the event data (ids, digests, reasons), never an output value. Update and
 * delete are refused by trigger.
 *
 * `mixed_output_preauthorizations`: a workspace admin's precise preauthorization for one
 * reference of one parent operation (see mixed-orchestration/preauthorization.ts). All bounds are
 * NOT NULL and constrained here as well as in code; only `uses` (monotonic, never above
 * `max_uses`) and the one-way revocation change after creation.
 */
export const migration0041MixedRuns = {
  version: 41,
  name: "mixed_runs",
  sql: `
create table if not exists platform.mixed_runs (
  workspace_id        text        not null,
  parent_operation_id text        not null,
  environment_id      text        not null,
  parent_digest       text        not null check (parent_digest ~ '^[0-9a-f]{64}$'),
  desired_digest      text        not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  state               jsonb       not null check (octet_length(state::text) <= 1048576),
  state_digest        text        not null check (state_digest ~ '^[0-9a-f]{64}$'),
  version             integer     not null default 1 check (version >= 1),
  open                boolean     not null,
  next_deadline_at    timestamptz,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, parent_operation_id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (state->>'workspaceId' = workspace_id and state->>'parentOperationId' = parent_operation_id
    and state->>'environmentId' = environment_id and state->>'desiredDigest' = desired_digest and state->'version' = '1'::jsonb)
);
create index if not exists mixed_runs_due on platform.mixed_runs (next_deadline_at) where open and next_deadline_at is not null;

create or replace function platform.mixed_runs_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Mixed runs are retained' using errcode = '23514';
  end if;
  if (new.workspace_id, new.parent_operation_id, new.environment_id, new.desired_digest, new.created_at)
     is distinct from (old.workspace_id, old.parent_operation_id, old.environment_id, old.desired_digest, old.created_at)
     or new.version <> old.version + 1 then
    raise exception 'Mixed run identity is immutable and version advances by one' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists mixed_runs_guard on platform.mixed_runs;
create trigger mixed_runs_guard before update or delete on platform.mixed_runs
for each row execute function platform.mixed_runs_guard();

create table if not exists platform.mixed_run_events (
  workspace_id        text        not null,
  parent_operation_id text        not null,
  seq                 integer     not null check (seq >= 0),
  kind                text        not null check (kind in ('run_created','start','succeed','fail','outage','tick','cancel','cancel_confirmed',
                                                          'reconciled','retry','rebind','teardown_planned','teardown_released','teardown_result')),
  child_id            text,
  event               jsonb       not null check (octet_length(event::text) <= 65536),
  state_digest        text        not null check (state_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, parent_operation_id, seq),
  foreign key (workspace_id, parent_operation_id) references platform.mixed_runs (workspace_id, parent_operation_id)
);

create or replace function platform.mixed_run_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Mixed run events are append-only' using errcode = '23514';
end
$$;
drop trigger if exists mixed_run_events_immutable on platform.mixed_run_events;
create trigger mixed_run_events_immutable before update or delete on platform.mixed_run_events
for each row execute function platform.mixed_run_events_immutable();

create table if not exists platform.mixed_output_preauthorizations (
  id                      text        not null primary key,
  workspace_id            text        not null,
  environment_id          text        not null,
  parent_operation_id     text        not null,
  created_by              text        not null check (length(created_by) between 1 and 200),
  created_by_name         text        not null check (length(created_by_name) between 1 and 200),
  desired_digest          text        not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  reference_id            text        not null check (length(reference_id) between 1 and 128),
  contract_digest         text        not null check (contract_digest ~ '^[0-9a-f]{64}$'),
  consumer_subplan_digest text        not null check (consumer_subplan_digest ~ '^[0-9a-f]{64}$'),
  producer_subplan_digest text        not null check (producer_subplan_digest ~ '^[0-9a-f]{64}$'),
  value_type              text        not null check (value_type in ('string','number','boolean','resource_id','endpoint','secret_ref')),
  secret_ref              text        check (secret_ref ~ '^vault:[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$'),
  value_digest            text        check (value_digest ~ '^[0-9a-f]{64}$'),
  max_uses                integer     not null check (max_uses between 1 and 10),
  uses                    integer     not null default 0 check (uses >= 0),
  expires_at              timestamptz not null,
  created_at              timestamptz not null,
  status                  text        not null default 'active' check (status in ('active','revoked')),
  revoked_at              timestamptz,
  revoked_by              text,
  revoked_reason          text        check (revoked_reason is null or length(revoked_reason) <= 300),
  unique (workspace_id, id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (uses <= max_uses),
  check ((value_type = 'secret_ref') = (secret_ref is not null)),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index if not exists mixed_output_preauthorizations_parent on platform.mixed_output_preauthorizations (workspace_id, parent_operation_id, created_at);

create or replace function platform.mixed_output_preauthorizations_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Output preauthorizations are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.environment_id, new.parent_operation_id, new.created_by, new.desired_digest, new.reference_id, new.contract_digest,
      new.consumer_subplan_digest, new.producer_subplan_digest, new.value_type, new.secret_ref, new.value_digest, new.max_uses, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.environment_id, old.parent_operation_id, old.created_by, old.desired_digest, old.reference_id, old.contract_digest,
      old.consumer_subplan_digest, old.producer_subplan_digest, old.value_type, old.secret_ref, old.value_digest, old.max_uses, old.expires_at, old.created_at)
     or new.uses < old.uses or (old.status = 'revoked' and new.status <> 'revoked') then
    raise exception 'Output preauthorization bounds are immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists mixed_output_preauthorizations_guard on platform.mixed_output_preauthorizations;
create trigger mixed_output_preauthorizations_guard before update or delete on platform.mixed_output_preauthorizations
for each row execute function platform.mixed_output_preauthorizations_guard();

alter table platform.mixed_runs enable row level security;
alter table platform.mixed_run_events enable row level security;
alter table platform.mixed_output_preauthorizations enable row level security;
do $$
declare r text;
declare t text;
begin
  foreach t in array array['mixed_runs','mixed_run_events','mixed_output_preauthorizations'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.mixed_runs to service_role;
    grant select,insert on table platform.mixed_run_events to service_role;
    grant select,insert,update on table platform.mixed_output_preauthorizations to service_role;
  end if;
end
$$;
`,
} as const;
