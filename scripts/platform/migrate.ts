/**
 * Migrate (or inspect) the platform control store — ADR-0002.
 *
 *     npx tsx scripts/platform/migrate.ts             # apply pending migrations
 *     npx tsx scripts/platform/migrate.ts --status    # show the ledger; exit 1 unless current
 *     npx tsx scripts/platform/migrate.ts --dry-run   # list what would be applied
 *     npx tsx scripts/platform/migrate.ts --url <postgres uri>   # target this database, not the environment's
 *
 * The target is decided exactly as the application decides it
 * (`platformDbConfigFromEnv`): ZENITH_PLATFORM_DB / ZENITH_PLATFORM_DB_URL /
 * SUPABASE_DB_URL, else the local PGlite directory `<ZENITH_DATA>/platform-pg`.
 * `.env.local` is read when present (real environment variables win).
 *
 * The application never runs DDL against Postgres by itself; this script (or
 * the emitted supabase/migrations/0016_platform_core.sql) is how a production
 * database is brought forward. Applying is idempotent and safe to run twice or
 * concurrently: each migration and its ledger row commit together under a table
 * lock, and an already-applied migration whose checksum changed is refused.
 *
 * The connection string is never printed — only host, port and database name.
 *
 * Exit codes: 0 ok, 1 not current (--status) or a refusal/failure, 2 usage error.
 */
import fs from "node:fs";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { openPlatformDb, platformDbConfigFromEnv, type OpenPlatformDbOptions } from "@/lib/controlplane/db/open";
import { assertPlatformSchemaCurrent, migratePlatformDb, platformSchemaStatus } from "@/lib/controlplane/db/migrator";

function loadDotEnvLocal(): void {
  try {
    if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
  } catch {
    /* an unreadable .env.local is not this script's problem; the real environment still applies */
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--") && a !== "--url"));
  const urlIndex = args.indexOf("--url");
  const url = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
  const known = new Set(["--status", "--dry-run"]);
  const unknown = [...flags].filter((f) => !known.has(f));
  if (unknown.length > 0 || (urlIndex >= 0 && !url)) {
    process.stderr.write(`Usage: npx tsx scripts/platform/migrate.ts [--status | --dry-run] [--url <postgres uri>]\n`);
    return 2;
  }

  loadDotEnvLocal();
  const config = url ? { kind: "postgres" as const, url, dataDir: undefined, max: 1 } : platformDbConfigFromEnv();
  const options: OpenPlatformDbOptions = { kind: config.kind, url: config.url, dataDir: config.dataDir, max: 1, migrate: false };
  const db = await openPlatformDb(options);
  try {
    process.stdout.write(`Platform control store: ${db.identity} (${db.kind})\n`);
    const status = await platformSchemaStatus(db);
    const applied = status.applied.map((a) => `${a.version}:${a.name}`).join(", ") || "none";
    const pending = status.pending.map((m) => `${m.version}:${m.name}`).join(", ") || "none";
    process.stdout.write(`Ledger: ${status.ledgerPresent ? "present" : "absent"}; applied: ${applied}; pending: ${pending}\n`);
    if (status.ahead.length > 0) process.stdout.write(`Ahead of this build (applied by a newer deploy): ${status.ahead.join(", ")}\n`);
    if (status.tampered.length > 0) {
      process.stderr.write(`Checksum mismatch for migration(s): ${status.tampered.map((t) => t.version).join(", ")} — a shipped migration was edited.\n`);
      return 1;
    }

    if (flags.has("--status")) return status.current ? 0 : 1;
    if (flags.has("--dry-run")) {
      process.stdout.write(status.pending.length ? `Would apply: ${pending}\n` : "Nothing to apply.\n");
      return 0;
    }

    const result = await migratePlatformDb(db);
    await assertPlatformSchemaCurrent(db);
    process.stdout.write(result.applied.length ? `Applied migrations: ${result.applied.join(", ")}\n` : "Already up to date.\n");
    return 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof ControlStoreError) process.stderr.write(`\n${err.code}: ${err.message}\n`);
    else process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
