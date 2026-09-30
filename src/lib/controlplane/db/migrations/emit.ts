/**
 * Renders `supabase/migrations/0014_platform_core.sql` from the TypeScript
 * migrations — the ONLY way that file is produced. It is never hand-edited: a
 * test (`tests/controlplane/migrations.test.ts`) fails when the committed file
 * differs by even one byte from what `renderSupabaseMigration()` returns now,
 * and `npx tsx scripts/platform/emit-sql.ts` rewrites it.
 *
 * What the emitted file is: the schema, every migration's DDL, the ledger rows
 * (with the same checksums the in-process migrator computes, so the migrator
 * recognises a Supabase-applied migration as applied), and the Supabase-only
 * hardening the TypeScript migrations deliberately do not carry because PGlite
 * and a plain Postgres have no such roles:
 *   - row level security ON for every table in `platform`, with NO policies
 *     (the service role bypasses RLS; nothing else may read these tables);
 *   - `anon` / `authenticated` lose every privilege on the schema;
 *   - `service_role` gets USAGE and table/sequence DML (mirrors 0007).
 * The role statements are guarded by `pg_roles`, so the same file also applies
 * to a plain PostgreSQL (CI, self-hosted) where those roles may not exist.
 *
 * `platform` is NOT added to the Data API's exposed schemas and must not be.
 */
import { BOOTSTRAP_SQL } from "./bootstrap";
import { PLATFORM_MIGRATIONS, migrationChecksum } from "./index";

export const EMITTED_FILE = "0014_platform_core.sql";

const HARDENING_SQL = `do $$
declare
  t record;
  r text;
begin
  for t in select tablename from pg_tables where schemaname = 'platform' loop
    execute format('alter table platform.%I enable row level security', t.tablename);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on all tables in schema platform from %I', r);
      execute format('revoke all on all sequences in schema platform from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on all tables in schema platform to service_role;
    grant usage, select, update on all sequences in schema platform to service_role;
    alter default privileges in schema platform grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema platform grant usage, select, update on sequences to service_role;
  end if;
end
$$;
`;

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** The exact text of `supabase/migrations/0014_platform_core.sql`. */
export function renderSupabaseMigration(): string {
  const parts: string[] = [
    `-- Zenith platform control store (ADR-0002) — schema \`platform\`.
--
-- GENERATED FILE — DO NOT EDIT.
-- Source:      src/lib/controlplane/db/migrations/*.ts
-- Regenerate:  npx tsx scripts/platform/emit-sql.ts
-- Verified by: tests/controlplane/migrations.test.ts (byte-for-byte)
--
-- Applied by the operator (Supabase SQL editor, or psql against
-- ZENITH_PLATFORM_DB_URL) or by \`npx tsx scripts/platform/migrate.ts\`, which
-- reaches the same end state through the same ledger. Idempotent: re-applying
-- is a no-op. The application never runs DDL against Postgres; it checks
-- \`platform.schema_migrations\` on start and refuses to run when it is behind.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that reads or writes these tables.
-- \`platform\` must never be added to the Data API's exposed schemas.
`,
    BOOTSTRAP_SQL,
  ];
  for (const migration of PLATFORM_MIGRATIONS) {
    parts.push(`-- ============================ migration ${migration.version}: ${migration.name} ============================\n`);
    parts.push(`${migration.sql.trim()}\n`);
    parts.push(
      `insert into platform.schema_migrations (version, name, checksum)\nvalues (${migration.version}, ${quote(migration.name)}, ${quote(migrationChecksum(migration))})\non conflict (version) do nothing;\n`
    );
  }
  parts.push(`-- ============================ hardening (Supabase roles) ============================\n`);
  parts.push(HARDENING_SQL);
  return parts.join("\n");
}

/** Repo-relative path of the emitted file (the script writes it, the sync test reads it). */
export const EMITTED_RELATIVE_PATH = `supabase/migrations/${EMITTED_FILE}`;
