/**
 * Compatibility for explicit operator/test installations of the original schema.
 * Normal installations use platform migration 6; request handlers never call this.
 * The SQL belongs to the immutable migration, not to mutable feature code.
 */
import type { Sql } from "@/lib/controlplane/types";
import { migration0006GithubSources } from "@/lib/controlplane/db/migrations/0006_github_sources";

export const GITHUB_SOURCE_SCHEMA_SQL = migration0006GithubSources.sql;

/** Legacy helper: installs tables only, without updating the platform ledger. */
export async function installGithubSourceSchema(db: Sql): Promise<void> {
  await db.tx(async (tx) => {
    for (const statement of GITHUB_SOURCE_SCHEMA_SQL.split(";").filter((part) => part.trim())) await tx.query(statement);
  });
}
