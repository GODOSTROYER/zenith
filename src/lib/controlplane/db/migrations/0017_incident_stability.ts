/**
 * Durable incident stability state (PROD-OBS-03).
 *
 * Adds, on top of `platform.incidents` / `platform.investigations`:
 *   - a fingerprint on incidents with a partial unique index, so concurrent
 *     observers of the same problem attach to ONE open incident (dedup),
 *   - per-fingerprint signal state (hysteresis counters, remediation cooldown),
 *   - an append-only-ish remediation attempt ledger (attempt limits, in-flight
 *     and rate caps, blocked proposals kept for audit),
 *   - maintenance windows, and
 *   - one deterministic postmortem record per resolved incident.
 *
 * Every table carries `workspace_id`; RLS and grants come from the aggregate
 * hardening in the emitted Supabase file. Idempotent DDL only.
 */
export const migration0017IncidentStability = {
  version: 17,
  name: "incident_stability",
  sql: `
alter table platform.incidents add column if not exists fingerprint text;
alter table platform.incidents add column if not exists occurrence_count integer not null default 1;
alter table platform.incidents add column if not exists last_seen_at timestamptz;
alter table platform.incidents add column if not exists escalated_at timestamptz;
alter table platform.incidents add column if not exists escalation_reasons jsonb not null default '[]'::jsonb;
create unique index if not exists incidents_open_fingerprint
  on platform.incidents (workspace_id, fingerprint)
  where fingerprint is not null and status <> 'resolved';

create table if not exists platform.incident_signal_state (
  workspace_id        text        not null,
  environment_id      text        not null,
  fingerprint         text        not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  state               text        not null default 'quiet' check (state in ('quiet','active')),
  consecutive_bad     integer     not null default 0 check (consecutive_bad >= 0),
  consecutive_good    integer     not null default 0 check (consecutive_good >= 0),
  last_observed_at    timestamptz not null,
  cooldown_until      timestamptz,
  updated_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, environment_id, fingerprint)
);

create table if not exists platform.incident_remediation_attempts (
  id               text        not null primary key,
  workspace_id     text        not null,
  incident_id      text        not null,
  environment_id   text        not null,
  fingerprint      text        not null,
  idempotency_key  text        not null check (idempotency_key ~ '^[a-f0-9]{64}$'),
  capability       text        not null,
  resource_id      text,
  blast_radius     text        not null check (blast_radius in ('low','medium','high')),
  status           text        not null check (status in ('reserved','succeeded','failed','abandoned','blocked')),
  block_codes      jsonb       not null default '[]'::jsonb,
  operation_id     text,
  reserved_at      timestamptz not null default clock_timestamp(),
  settled_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);
create unique index if not exists incident_attempts_key_live
  on platform.incident_remediation_attempts (workspace_id, incident_id, idempotency_key) where status <> 'blocked';
create index if not exists incident_attempts_incident on platform.incident_remediation_attempts (workspace_id, incident_id, reserved_at);
create index if not exists incident_attempts_env on platform.incident_remediation_attempts (workspace_id, environment_id, reserved_at);
create index if not exists incident_attempts_fp on platform.incident_remediation_attempts (workspace_id, fingerprint, reserved_at);

create table if not exists platform.incident_maintenance_windows (
  id              text        not null primary key,
  workspace_id    text        not null,
  environment_id  text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text        not null,
  created_by      text        not null,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '7 days')
);
create index if not exists incident_windows_ws on platform.incident_maintenance_windows (workspace_id, ends_at desc);

create table if not exists platform.incident_postmortems (
  id             text        not null primary key,
  workspace_id   text        not null,
  incident_id    text        not null,
  document       jsonb       not null,
  document_digest text       not null check (document_digest ~ '^[a-f0-9]{64}$'),
  created_at     timestamptz not null default clock_timestamp(),
  unique (workspace_id, incident_id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);
`,
} as const;
