/**
 * Migration 3 — the zenithd request queue (`platform.machine_requests`).
 *
 * Migration 1 has a queue for RUNNER jobs (`runner_jobs`, foreign key to
 * `platform.runners`) but none for zenithd machines, which live in
 * `platform.machines`. This is its mirror: same columns, same statuses, same
 * tenancy rules (composite `(workspace_id, …)` foreign keys, so a request can
 * never point at another tenant's machine or operation), same log table shape.
 * Authored by the runner workstream (`src/lib/runners/db/machine-requests.ts`
 * is its repository).
 *
 * This text is hashed into the ledger checksum. Once released, never edit it;
 * add migration 4.
 */
import type { PlatformMigration } from "./index";

export const migration0003MachineRequests: PlatformMigration = {
  version: 3,
  name: "machine_requests",
  sql: `
/* ------------------------ zenithd requests (mirror of runner_jobs) ------------------------ */

create table if not exists platform.machine_requests (
  id           text        not null primary key,   -- the signed envelope's jti (mreq_…)
  machine_id   text        not null,
  workspace_id text        not null,
  operation_id text        not null,
  operation    text        not null,               -- the machine operation (also the grant's capability)
  capability   text        not null,
  envelope     text        not null,
  status       text        not null default 'queued' check (status in (
                 'queued','claimed','running','succeeded','failed','rejected','timed_out','expired','cancelled')),
  lease_until  timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default clock_timestamp(),
  claimed_at   timestamptz,
  started_at   timestamptz,
  expires_at   timestamptz not null,
  settled_at   timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, machine_id)   references platform.machines (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists machine_requests_queue on platform.machine_requests (machine_id, created_at, id) where status = 'queued';
create index if not exists machine_requests_ws_op on platform.machine_requests (workspace_id, operation_id);
create index if not exists machine_requests_inflight on platform.machine_requests (lease_until) where status in ('claimed','running');

create table if not exists platform.machine_request_logs (
  id           bigint generated always as identity primary key,
  request_id   text        not null,
  workspace_id text        not null,
  batch_seq    integer     not null,
  line_no      integer     not null,
  ts           timestamptz not null,
  stream       text        not null check (stream in ('stdout','stderr','info')),
  line         text        not null check (char_length(line) <= 8192),
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (request_id, batch_seq, line_no),
  foreign key (workspace_id, request_id) references platform.machine_requests (workspace_id, id) on delete cascade
);
create index if not exists machine_request_logs_ws_req on platform.machine_request_logs (workspace_id, request_id, id);
`,
};
