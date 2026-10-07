/**
 * PROD-OPS-04: recovery epochs.
 *
 * A restore rewinds the database. Everything that exists only to be single-use or monotonic (a consumed approval,
 * an accepted external effect, a delivered intent, a lease fence) looks fresh again, and a worker or Temporal
 * history that survived the restore still remembers the old timeline. A recovery epoch is the fence that makes
 * the rewind visible to every check:
 *
 *  - `recovery_epochs` is append-only and monotonic. Epoch 0 is the genesis epoch. A restore appends the next
 *    epoch (`bumpRecoveryEpoch`, run by the restore runbook, never by a request path).
 *  - `current_recovery_epoch()` is the answer to "which epoch is this database in". It is the DEFAULT of a new
 *    `recovery_epoch` column on operations, approvals, durable intents and external effects, so a row is stamped
 *    by the database at insert and no writer can forget. A row stamped below the current epoch was written by an
 *    earlier timeline.
 *  - Fence tokens carry the epoch: a lease acquired in epoch E has `fence_token >= E * 1e9 + 1`
 *    (`recovery_fence_floor()`), so a token issued in any earlier epoch can never equal a live fence again.
 *  - `recovery_items` is the work list a bump produces: every operation, intent and external effect that was in
 *    flight in the restored data. Each needs an explicit human decision (resume, abandon or keep uncertain);
 *    nothing is resumed by a timer.
 *
 * Expand-only: new tables and functions, defaulted columns. The previous release keeps working against this
 * schema (its inserts take the default).
 */
export const migration0044RecoveryEpochs = {
  version: 44,
  name: "recovery_epochs",
  sql: `
create table if not exists platform.recovery_epochs (
  epoch           bigint      not null primary key check (epoch >= 0 and epoch <= 9000),
  kind            text        not null check (kind in ('genesis','restore')),
  actor           text        not null check (char_length(actor) between 1 and 200),
  reason          text        not null check (char_length(reason) between 1 and 500),
  restore_run_id  text        unique check (restore_run_id is null or restore_run_id ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  manifest_digest text        check (manifest_digest is null or manifest_digest ~ '^[a-f0-9]{64}$'),
  backup_id       text        check (backup_id is null or char_length(backup_id) between 1 and 128),
  backup_taken_at timestamptz,
  prior_epoch     bigint      check (prior_epoch is null or prior_epoch >= 0),
  observed_epoch  bigint      check (observed_epoch is null or observed_epoch >= 0),
  created_at      timestamptz not null default clock_timestamp(),
  check ((kind = 'genesis') = (epoch = 0)),
  check (kind = 'genesis' or restore_run_id is not null)
);
insert into platform.recovery_epochs (epoch, kind, actor, reason)
values (0, 'genesis', 'migration', 'initial recovery epoch')
on conflict (epoch) do nothing;

create or replace function platform.recovery_epochs_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Recovery epochs are append-only';
end $$;
drop trigger if exists recovery_epochs_append_only on platform.recovery_epochs;
create trigger recovery_epochs_append_only before update or delete on platform.recovery_epochs
  for each row execute function platform.recovery_epochs_append_only();

create or replace function platform.current_recovery_epoch() returns bigint language sql stable as $$
  select coalesce(max(epoch), 0)::bigint from platform.recovery_epochs
$$;
create or replace function platform.recovery_fence_floor() returns bigint language sql stable as $$
  select platform.current_recovery_epoch() * 1000000000::bigint + 1
$$;

alter table platform.operations add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.approvals add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.durable_intents add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.external_effects add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();

create table if not exists platform.recovery_items (
  id            text        not null primary key check (id ~ '^ri_[a-f0-9]{40}$'),
  workspace_id  text        not null check (char_length(workspace_id) between 1 and 128),
  epoch         bigint      not null references platform.recovery_epochs (epoch),
  kind          text        not null check (kind in ('operation','intent','effect')),
  ref           text        not null check (char_length(ref) between 1 and 200),
  environment_id text       check (environment_id is null or char_length(environment_id) between 1 and 128),
  prior_state   text        not null check (char_length(prior_state) between 1 and 64),
  allowed       text[]      not null check (allowed <@ array['resume','abandon','keep_uncertain']::text[] and cardinality(allowed) >= 1),
  state         text        not null default 'pending' check (state in ('pending','resumed','abandoned','kept_uncertain')),
  decided_by    text        check (decided_by is null or char_length(decided_by) between 1 and 200),
  decision_reason text      check (decision_reason is null or char_length(decision_reason) between 1 and 500),
  decision_digest text      check (decision_digest is null or decision_digest ~ '^[a-f0-9]{64}$'),
  decided_at    timestamptz,
  created_at    timestamptz not null default clock_timestamp(),
  unique (epoch, workspace_id, kind, ref),
  check ((state = 'pending') = (decided_at is null)),
  check (state = 'pending' or (decided_by is not null and decision_reason is not null and decision_digest is not null))
);
create index if not exists recovery_items_ws_state on platform.recovery_items (workspace_id, state, epoch);

create or replace function platform.recovery_item_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Recovery items cannot be deleted';
  end if;
  if (new.id, new.workspace_id, new.epoch, new.kind, new.ref, new.prior_state, new.allowed, new.created_at)
     is distinct from (old.id, old.workspace_id, old.epoch, old.kind, old.ref, old.prior_state, old.allowed, old.created_at) then
    raise exception using errcode = '23514', message = 'Recovery item identity is immutable';
  end if;
  if old.state <> 'pending' and new is distinct from old then
    raise exception using errcode = '23514', message = 'A decided recovery item cannot change';
  end if;
  if new.state <> 'pending' and not (new.state = 'resumed' and 'resume' = any(new.allowed)
       or new.state = 'abandoned' and 'abandon' = any(new.allowed)
       or new.state = 'kept_uncertain' and 'keep_uncertain' = any(new.allowed)) then
    raise exception using errcode = '23514', message = 'That decision is not allowed for this recovery item';
  end if;
  return new;
end $$;
drop trigger if exists recovery_item_guard on platform.recovery_items;
create trigger recovery_item_guard before update or delete on platform.recovery_items
  for each row execute function platform.recovery_item_guard();

alter table platform.recovery_epochs enable row level security;
alter table platform.recovery_items enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['recovery_epochs','recovery_items'] loop
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
    grant select, insert on table platform.recovery_epochs to service_role;
    grant select, insert, update on table platform.recovery_items to service_role;
  end if;
end
$$;
`,
} as const;
