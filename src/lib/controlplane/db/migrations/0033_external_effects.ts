/**
 * Permanent external-effect ledger (PROD-DUR-07 / PROD-DUR-08).
 *
 * One row per provider mutation Zenith dispatched or refused to dispatch. Rows
 * are inserted BEFORE the provider call and never deleted. The trigger below is
 * the authority on legal state changes: `confirmed` and `tombstoned` are
 * terminal, `uncertain` and `conflict` only leave through an operator
 * resolution row bound to the exact effect version and readback digest, and
 * receipts are write-once. Appends to `external_effect_events` and
 * `external_effect_resolutions` are immutable.
 */
import type { PlatformMigration } from "./index";

export const migration0033ExternalEffects: PlatformMigration = {
  version: 33,
  name: "external_effects",
  sql: `
create table if not exists platform.external_effects (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  effect_id text not null check (effect_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  family text not null check (family in ('build_launch','cleanup_apply')),
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  environment_id text check (environment_id is null or environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,32}$'),
  dedup_key text not null check (dedup_key ~ '^[A-Za-z0-9_.:/=+-]{1,256}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  target jsonb not null default '{}'::jsonb check (jsonb_typeof(target) = 'object' and octet_length(target::text) <= 8000),
  idempotency_token text check (idempotency_token is null or idempotency_token ~ '^[A-Za-z0-9_.:-]{1,256}$'),
  idempotency_supported boolean not null,
  fence_scope text check (fence_scope is null or char_length(fence_scope) <= 256),
  fence_epoch bigint check (fence_epoch is null or fence_epoch >= 0),
  state text not null default 'pending' check (state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  state_reason text check (state_reason is null or char_length(state_reason) <= 500),
  provider_receipt jsonb check (provider_receipt is null or (jsonb_typeof(provider_receipt) = 'object' and octet_length(provider_receipt::text) <= 8000)),
  late_receipt jsonb check (late_receipt is null or (jsonb_typeof(late_receipt) = 'object' and octet_length(late_receipt::text) <= 8000)),
  readback jsonb check (readback is null or (jsonb_typeof(readback) = 'object' and octet_length(readback::text) <= 16000)),
  tombstone_reason text check (tombstone_reason is null or tombstone_reason in ('provider_rejected','operator_resolved_not_applied','superseded')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  uncertain_at timestamptz,
  primary key (workspace_id, effect_id),
  unique (workspace_id, family, dedup_key),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check ((state = 'tombstoned') = (tombstone_reason is not null)),
  check (state not in ('accepted','confirmed') or provider_receipt is not null or (state = 'confirmed' and readback is not null)),
  check (state not in ('uncertain') or uncertain_at is not null)
);
create index if not exists external_effects_operation on platform.external_effects (workspace_id, operation_id);
create index if not exists external_effects_open on platform.external_effects (workspace_id, state)
  where state in ('pending','accepted','uncertain','conflict');
create index if not exists external_effects_pending_sweep on platform.external_effects (updated_at)
  where state = 'pending';

create table if not exists platform.external_effect_events (
  seq bigint generated always as identity primary key,
  workspace_id text not null,
  effect_id text not null,
  kind text not null check (kind ~ '^[a-z_]{1,48}$'),
  from_state text check (from_state is null or from_state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  to_state text not null check (to_state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  actor text not null check (char_length(actor) between 1 and 200),
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'),
  at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, effect_id) references platform.external_effects (workspace_id, effect_id)
);
create index if not exists external_effect_events_effect on platform.external_effect_events (workspace_id, effect_id, seq);

create table if not exists platform.external_effect_resolutions (
  id text not null primary key check (id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  workspace_id text not null,
  effect_id text not null,
  effect_version integer not null check (effect_version >= 1),
  decision text not null check (decision in ('confirm_applied','confirm_not_applied')),
  readback_digest text not null check (readback_digest ~ '^[a-f0-9]{64}$'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  approver_id text not null check (char_length(approver_id) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, effect_id, effect_version),
  foreign key (workspace_id, effect_id) references platform.external_effects (workspace_id, effect_id)
);

create or replace function platform.external_effect_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'External effect events and resolutions cannot be changed or removed';
end $$;
drop trigger if exists external_effect_events_append_only on platform.external_effect_events;
create trigger external_effect_events_append_only before update or delete on platform.external_effect_events
  for each row execute function platform.external_effect_append_only();
drop trigger if exists external_effect_resolutions_append_only on platform.external_effect_resolutions;
create trigger external_effect_resolutions_append_only before update or delete on platform.external_effect_resolutions
  for each row execute function platform.external_effect_append_only();

-- A resolution is accepted only for an effect that is still unresolved at exactly the reviewed version, and only
-- against the readback the approver reviewed: no evidence, no resolution.
create or replace function platform.external_effect_resolution_guard() returns trigger language plpgsql as $$
declare e platform.external_effects%rowtype;
begin
  select * into e from platform.external_effects where workspace_id = new.workspace_id and effect_id = new.effect_id for share;
  if not found or e.state not in ('uncertain','conflict') or e.version <> new.effect_version
     or e.readback is null or e.readback->>'digest' is distinct from new.readback_digest
     or (new.decision = 'confirm_applied' and e.readback->>'outcome' <> 'present')
     or (new.decision = 'confirm_not_applied' and e.readback->>'outcome' <> 'absent') then
    raise exception using errcode = '23514', message = 'A resolution needs the reviewed readback of the current unresolved effect';
  end if;
  -- Absence is evidence only once the dispatching fence can no longer act (a renewed lease keeps its fence, so a
  -- live holder blocks it) and a quiet period has passed since the call could last have been in flight.
  if new.decision = 'confirm_not_applied' and (
       exists (select 1 from platform.leases l where l.scope = e.fence_scope and l.fence_token = e.fence_epoch
         and l.expires_at > clock_timestamp() and l.released_at is null)
       or e.late_receipt is not null
       or (e.readback->>'observedAt')::timestamptz < greatest(coalesce(e.uncertain_at, e.created_at), e.created_at) + interval '15 minutes') then
    raise exception using errcode = '23514', message = 'Absence cannot be accepted while the original fence is live or inside the settle window';
  end if;
  return new;
end $$;
drop trigger if exists external_effect_resolution_guard on platform.external_effect_resolutions;
create trigger external_effect_resolution_guard before insert on platform.external_effect_resolutions
  for each row execute function platform.external_effect_resolution_guard();

create or replace function platform.external_effect_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'External effects are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.effect_id, new.family, new.operation_id, new.environment_id, new.provider, new.dedup_key,
      new.request_digest, new.target, new.idempotency_token, new.idempotency_supported, new.fence_scope, new.fence_epoch, new.created_at)
     is distinct from
     (old.workspace_id, old.effect_id, old.family, old.operation_id, old.environment_id, old.provider, old.dedup_key,
      old.request_digest, old.target, old.idempotency_token, old.idempotency_supported, old.fence_scope, old.fence_epoch, old.created_at) then
    raise exception using errcode = '23514', message = 'External effect identity is immutable';
  end if;
  if (old.provider_receipt is not null and new.provider_receipt is distinct from old.provider_receipt)
     or (old.late_receipt is not null and new.late_receipt is distinct from old.late_receipt) then
    raise exception using errcode = '23514', message = 'External effect receipts are write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'External effect updates must advance the version by one';
  end if;
  if old.state in ('confirmed','tombstoned') then
    if new.state is distinct from old.state or new.tombstone_reason is distinct from old.tombstone_reason
       or new.provider_receipt is distinct from old.provider_receipt or new.readback is distinct from old.readback then
      raise exception using errcode = '23514', message = 'A confirmed or tombstoned effect is terminal';
    end if;
    return new;
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending' and new.state = 'accepted' and new.provider_receipt is not null then
      null;
    elsif old.state = 'pending' and new.state = 'uncertain' then
      null;
    elsif old.state = 'pending' and new.state = 'tombstoned' and new.tombstone_reason = 'provider_rejected' then
      null;
    elsif old.state = 'accepted' and new.state = 'confirmed' and new.readback->>'outcome' = 'present' and new.provider_receipt is not null then
      null;
    elsif old.state = 'accepted' and new.state in ('uncertain','conflict') then
      null;
    elsif old.state = 'uncertain' and new.state = 'conflict' then
      null;
    elsif old.state in ('uncertain','conflict') and new.state = 'confirmed' and new.readback->>'outcome' = 'present'
          and exists (select 1 from platform.external_effect_resolutions r where r.workspace_id = old.workspace_id
            and r.effect_id = old.effect_id and r.effect_version = old.version and r.decision = 'confirm_applied'
            and r.readback_digest = new.readback->>'digest') then
      null;
    elsif old.state in ('uncertain','conflict') and new.state = 'tombstoned' and new.tombstone_reason = 'operator_resolved_not_applied'
          and exists (select 1 from platform.external_effect_resolutions r where r.workspace_id = old.workspace_id
            and r.effect_id = old.effect_id and r.effect_version = old.version and r.decision = 'confirm_not_applied'
            and r.readback_digest = new.readback->>'digest') then
      null;
    else
      raise exception using errcode = '23514', message = 'Illegal external effect transition';
    end if;
  elsif old.state in ('uncertain','conflict') and new.readback is distinct from old.readback and new.readback is null then
    raise exception using errcode = '23514', message = 'Readback evidence cannot be erased';
  end if;
  return new;
end $$;
drop trigger if exists external_effect_guard on platform.external_effects;
create trigger external_effect_guard before update or delete on platform.external_effects
  for each row execute function platform.external_effect_guard();

alter table platform.external_effects enable row level security;
alter table platform.external_effect_events enable row level security;
alter table platform.external_effect_resolutions enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['external_effects','external_effect_events','external_effect_resolutions'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- Creator defaults can include DELETE and TRUNCATE; the ledger admits neither.
    revoke all on table platform.external_effects from service_role;
    revoke all on table platform.external_effect_events from service_role;
    revoke all on table platform.external_effect_resolutions from service_role;
    grant select, insert, update on table platform.external_effects to service_role;
    grant select, insert on table platform.external_effect_events to service_role;
    grant select, insert on table platform.external_effect_resolutions to service_role;
  end if;
end $$;
`,
};
