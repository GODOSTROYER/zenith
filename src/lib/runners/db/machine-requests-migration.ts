/**
 * Platform-store migration for the zenithd request queue (`platform.machine_requests`).
 *
 * WS-DB's core schema has a queue for RUNNER jobs (`runner_jobs`, whose foreign
 * key points at `platform.runners`) but none for zenithd machines, which live in
 * `platform.machines`. This is its mirror: same columns, same statuses, same
 * tenancy rules (composite `(workspace_id, …)` foreign keys, so a request can
 * never point at another tenant's machine or operation), same log table shape.
 *
 * INTEGRATION STEP (outside WS-RUNSRV's paths, so not done here): append
 * `migrationMachineRequests` to `PLATFORM_MIGRATIONS`
 * (`src/lib/controlplane/db/migrations/index.ts`) as version 2, then re-emit the
 * Supabase file (`npx tsx scripts/platform/emit-sql.ts`; `tests/controlplane/migrations.test.ts`
 * pins it byte for byte). Until then the zenithd half of the runner plane fails
 * with "relation platform.machine_requests does not exist" while the runner half
 * is unaffected. This text is hashed into the ledger checksum: once released,
 * never edit it.
 */
import type { PlatformMigration } from "@/lib/controlplane/db/migrations/index";

export const migrationMachineRequests: PlatformMigration = {
  version: 2,
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
