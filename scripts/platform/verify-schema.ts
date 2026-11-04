/**
 * Read-only CI check of the emitted Supabase platform schema. Requires the
 * explicit lane SUPABASE_DB_URL; never reads .env.local or migrates on open.
 * Runtime checksum/version compatibility comes from assertPlatformSchemaCurrent.
 * Known ledger names are also compared with the canonical migration manifest.
 * Additive migrations from a newer build remain compatible with this build.
 */
import { pathToFileURL } from "node:url";
import type { Sql } from "@/lib/controlplane/types";
import { PlatformSchemaError } from "@/lib/controlplane/db/errors";
import { openPlatformDb } from "@/lib/controlplane/db/open";
import { assertPlatformSchemaCurrent, platformSchemaStatus, type PlatformSchemaStatus } from "@/lib/controlplane/db/migrator";
import { PLATFORM_MIGRATIONS, type PlatformMigration } from "@/lib/controlplane/db/migrations/index";

export async function verifyPlatformSchema(
  sql: Sql,
  migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
): Promise<PlatformSchemaStatus> {
  await assertPlatformSchemaCurrent(sql, migrations);
  const status = await platformSchemaStatus(sql, migrations);
  const names = new Map(migrations.map((migration) => [migration.version, migration.name]));
  const renamed = status.applied.filter((row) => names.has(row.version) && row.name !== names.get(row.version));
  if (renamed.length > 0) {
    throw new PlatformSchemaError("schema_tampered", "The platform schema ledger has an unexpected name for a known migration.", {
      versions: renamed.map((row) => row.version),
    });
  }
  return status;
}

type Output = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };

/** Fixed diagnostics only: driver errors and ledger row values may contain secrets. */
export async function verifySchemaMain(
  env: { SUPABASE_DB_URL?: string } = { SUPABASE_DB_URL: process.env.SUPABASE_DB_URL },
  open: typeof openPlatformDb = openPlatformDb,
  output: Output = process
): Promise<number> {
  const url = env.SUPABASE_DB_URL?.trim();
  if (!url) {
    output.stderr.write("::error::SUPABASE_DB_URL is not set; no lane database can be verified.\n");
    return 1;
  }
  try {
    const db = await open({ kind: "postgres", url, max: 1, migrate: false });
    let status: PlatformSchemaStatus;
    try {
      status = await verifyPlatformSchema(db);
    } finally {
      await db.close();
    }
    output.stdout.write("Known platform migrations verified against the canonical migration manifest.\n");
    if (status.ahead.length > 0) {
      output.stdout.write("Additional migration versions are compatible with this build; their names/checksums were not verified.\n");
    }
    return 0;
  } catch (err: unknown) {
    const reason = err instanceof PlatformSchemaError
      ? err.code === "schema_behind"
        ? "schema_behind: the platform ledger is absent or a known migration is missing."
        : "schema_tampered: a known platform migration checksum or name does not match this build."
      : "The platform schema could not be verified; check lane connectivity and schema access.";
    output.stderr.write(`::error::${reason}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifySchemaMain().then((code) => { process.exitCode = code; });
}
