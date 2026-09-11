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
