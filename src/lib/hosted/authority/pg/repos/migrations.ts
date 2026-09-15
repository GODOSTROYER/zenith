/**
 * `hosted.schema_migrations`, read-only.
 *
 * The Postgres authority does not apply migrations. `supabase/migrations/0002_hosted_authority.sql`
 * is applied by hand by whoever owns the Supabase project, for one reason worth
 * stating: this process runs as a serverless function that can start a hundred
 * copies of itself in a second, and a hundred copies racing `CREATE TABLE` on a
 * free-tier pooler is not a migration strategy. So the schema is somebody's
 * deliberate act, and this reads back whether that act happened.
 *
 * It is not part of `Repos` — no caller has ever wanted it — so it lives here
 * rather than in the repository set.
 */
import type { AppliedMigration } from "../../schema";
import type { Sql, TransactionSql } from "../client";
import { PG_UNDEFINED_TABLE, pgErrorCode } from "../errors";
import { readNumber, readText, type PgRow } from "../rows";

/**
 * What `hosted.schema_migrations` records, oldest first.
 *
 * A missing table answers with an empty list rather than throwing: "no
 * migrations have been applied" is exactly what a database with no `hosted`
 * schema means, and the boot check's message about it is better than the
 * driver's `relation "hosted.schema_migrations" does not exist`.
 */
export async function readAppliedMigrations(sql: Sql | TransactionSql): Promise<AppliedMigration[]> {
  let rows: PgRow[];
  try {
    rows = (await sql`
      select version, name, applied_at
      from hosted.schema_migrations
      order by version
    `) as unknown as PgRow[];
  } catch (err) {
    if (pgErrorCode(err) === PG_UNDEFINED_TABLE) return [];
    throw err;
  }
  return rows.map((row) => ({
    version: readNumber(row, "version"),
    name: readText(row, "name"),
    appliedAt: readText(row, "applied_at"),
  }));
}

/**
 * Verify the v3 invariant at the database, not only in the migration ledger.
 * A manually edited or partially restored `schema_migrations` row must not
 * convince the runtime that concurrent pending-invite issuance is fenced.
 */
export async function hasPendingInviteUniquenessIndex(sql: Sql | TransactionSql): Promise<boolean> {
  let rows: PgRow[];
  try {
    rows = (await sql`
      select i.indexrelid::regclass::text as indexname,
             pg_get_indexdef(i.indexrelid) as indexdef,
             pg_get_expr(i.indpred, i.indrelid) as predicate
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'hosted'
        and c.relname = 'app_invites'
        and i.indexrelid::regclass::text = 'hosted.app_invites_pending_email'
    `) as unknown as PgRow[];
  } catch (err) {
    if (pgErrorCode(err) === PG_UNDEFINED_TABLE) return false;
    throw err;
  }

  return rows.some((row) => {
    const name = readText(row, "indexname");
    const definition = readText(row, "indexdef").replace(/\s+/g, " ").toLowerCase();
    const predicate = readText(row, "predicate").replace(/\s+/g, " ").toLowerCase().replace(/^\((.*)\)$/, "$1");
    return (
      (name === "app_invites_pending_email" || name === "hosted.app_invites_pending_email") &&
      definition.includes("create unique index") &&
      definition.includes("on hosted.app_invites") &&
      /\(app_id, lower\(\(?email\)?(?:::text)?\)\)/.test(definition) &&
      (predicate === "state = 'pending'::text" || predicate === "state = 'pending'")
    );
  });
}
