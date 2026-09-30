/**
 * The two objects every migration run needs before it can record anything: the
 * `platform` schema and its ledger. Idempotent, and shared verbatim by the
 * in-process migrator and the emitted Supabase file (`emit.ts`), so the ledger
 * a Supabase SQL-editor run creates is the ledger the TypeScript migrator reads.
 *
 * `checksum` is the SHA-256 of a migration's SQL text; the migrator refuses to
 * proceed when an applied migration's checksum no longer matches the code, so a
 * shipped migration can never be silently edited (ship a new one instead).
 */
export const BOOTSTRAP_SQL = `create schema if not exists platform;

create table if not exists platform.schema_migrations (
  version    integer     not null primary key,
  name       text        not null,
  applied_at timestamptz not null default now(),
  checksum   text        not null check (checksum ~ '^[0-9a-f]{64}$')
);
`;
