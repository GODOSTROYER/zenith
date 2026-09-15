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
 * Does this row describe the pending-invite uniqueness index?
 *
 * Split out from the query, and deliberately free of any rendered *name*.
 * `regclass::text` and `pg_get_indexdef()` schema-qualify only when the schema
 * is not on the connection's `search_path`, so a role- or database-level
 * `ALTER ROLE … SET search_path = hosted, public` — an ordinary operator action
 * that Supavisor carries — makes the same correct index render as
 * `app_invites_pending_email` / `ON app_invites` instead of
 * `hosted.app_invites_pending_email` / `ON hosted.app_invites`. Matching on that
 * text produced a false "index is missing" against a perfectly correct database,
 * and because the boot check memoises its rejection, a permanent refusal.
 *
 * What is checked here is search_path-independent: the catalog's own
 * uniqueness/validity flags, the column expression, and the partial predicate.
 * *Which* table and index the row belongs to is settled by the query's catalog
 * joins, not by reading a string.
 */
export function isPendingInviteUniquenessIndex(row: PgRow): boolean {
  const definition = readText(row, "indexdef").replace(/\s+/g, " ").toLowerCase();
  const predicate = readText(row, "predicate").replace(/\s+/g, " ").toLowerCase().replace(/^\((.*)\)$/, "$1");
  return (
    readBoolean(row, "isunique") &&
    readBoolean(row, "isvalid") &&
    definition.includes("create unique index") &&
    // `email` is `text` in 0002, so Postgres renders `lower(email)`; the
    // optional cast covers a column that is varchar on an older database.
    /\(app_id, lower\(\(?email\)?(?:::text)?\)\)/.test(definition) &&
    (predicate === "state = 'pending'::text" || predicate === "state = 'pending'")
  );
}

/** `true`/`false` however the driver hands a boolean back. */
function readBoolean(row: PgRow, column: string): boolean {
  const value = (row as Record<string, unknown>)[column];
  return value === true || value === "t" || value === "true";
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
      select pg_get_indexdef(i.indexrelid) as indexdef,
             pg_get_expr(i.indpred, i.indrelid) as predicate,
             i.indisunique as isunique,
             i.indisvalid as isvalid
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_class ic on ic.oid = i.indexrelid
      where n.nspname = 'hosted'
        and c.relname = 'app_invites'
        and ic.relname = 'app_invites_pending_email'
    `) as unknown as PgRow[];
  } catch (err) {
    if (pgErrorCode(err) === PG_UNDEFINED_TABLE) return false;
    throw err;
  }

  return rows.some(isPendingInviteUniquenessIndex);
}
