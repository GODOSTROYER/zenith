# ADR-0002 — Platform control store: Postgres schema `platform`, PGlite locally

Status: accepted (2026-09-30)

## Context
Operations, leases with fence tokens, durable idempotency, approvals, policy
decisions, grants, resources/observations, runners and incidents need real
transactions and conditional updates. The product store is PostgREST with no
cross-table atomicity (production-hardening ADR D-4). The hosted authority and
agent journal each maintain two SQL dialects (SQLite + Postgres).

## Decision
A fifth named authority, the **platform control store**
(`src/lib/controlplane/db`), with ONE dialect: PostgreSQL.
- Production/self-hosted: Postgres via `postgres` (porsager), schema
  `platform`, URL `ZENITH_PLATFORM_DB_URL` (falls back to `SUPABASE_DB_URL`).
  Works through the Supavisor transaction pooler (no session state, no
  advisory locks; leases are rows).
- Local development and tests: PGlite (Postgres compiled to WASM, in
  process), in-memory for tests, `<ZENITH_DATA>/platform-pg` for dev.
- Migrations are TypeScript modules exporting SQL, applied by an in-process
  migrator with a `platform.schema_migrations` ledger. PGlite migrates on open;
  Postgres is migrated by the operator (`npm run migrate:platform`) or by the
  emitted `supabase/migrations/00NN_platform_*.sql`; the app checks the ledger
  and fails closed when behind. A test keeps the emitted SQL in sync.

## Consequences
One repository implementation, real `BEGIN/COMMIT`, `FOR UPDATE SKIP LOCKED`
and `INSERT … ON CONFLICT` everywhere, including tests, without Docker. The
CI Postgres lane runs the same contract suite against Postgres 16.

## Supported installation addendum (2026-10-08)

The product Supabase database also contains the platform schema. This is the only
supported production/self-hosted installation topology. Runtime
`ZENITH_PLATFORM_DB_URL` equals `SUPABASE_DB_URL` and connects as `postgres`
through the verified-TLS transaction pooler. The migrator uses that same Supabase
project's direct/session endpoint on 5432. Committed Supabase migrations already
install platform; this decision introduces no migration.

MCP final admission performs a single SQL statement CAS from prepared to attempted,
checking current authority across `public.*` and `platform.*` within one ACID
transaction. Separate servers cannot satisfy that predicate and are unsupported.
Any future split requires a new DUR protocol and reviewed guarantees, never a
fallback, callback, proof flag or alternate runtime role. Opened-handle provenance,
actual-role checks and the final recheck remain mandatory. Model output cannot
supply credentials, approvals or execution authority.
