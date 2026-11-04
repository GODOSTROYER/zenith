/**
 * Read-only at-rest census of every sealed column in the sensitive persistence inventory (PROD-OPS-06).
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/sensitive-data-census.ts [--db platform|product] [--sample 1..10000] [--json]
 *
 * `--db platform` (default) opens the platform control store; `--db product` opens SUPABASE_DB_URL, where
 * `public.secrets`, `hosted.*` and `agent.*` live when they are not in the same database. Tables absent from the
 * chosen database are reported as absent, not as failures. The output is column names, counts and fixed reason
 * strings; stored values are never printed. This proves only that nothing plain-looking sits in a column that
 * must hold ciphertext (see src/lib/sensitivedata/at-rest.ts); it is a sample, not a certification.
 * Exit 0 clean, 1 violations or failure, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { atRestCensus } from "@/lib/sensitivedata/at-rest";

export async function censusMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  let target: "platform" | "product" = "platform";
  let sample = 500;
  let json = false;
  const seen = new Set<string>();
  const usage = (): number => { error("Usage: npx tsx --env-file-if-exists=.env.local scripts/sensitive-data-census.ts [--db platform|product] [--sample 1..10000] [--json]"); return 2; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) return usage();
    seen.add(arg);
    if (arg === "--json") json = true;
    else if (arg === "--db") { const v = args[++i]; if (v !== "platform" && v !== "product") return usage(); target = v; }
    else if (arg === "--sample") { const v = args[++i]; if (!v || !/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > 10_000) return usage(); sample = Number(v); }
    else return usage();
  }
  let db: PlatformDb | undefined;
  try {
    const url = target === "product" ? env.SUPABASE_DB_URL?.trim() : platformDbConfigFromEnv(env).url;
    if (!url) { error(`No Postgres URL is configured for the ${target} database.`); return 1; }
    db = await openPlatformDb({ kind: "postgres", url, max: 1, migrate: false });
    const results = await atRestCensus(db, { sample });
    for (const r of results) output(json ? JSON.stringify(r) : `${r.id.padEnd(20)} ${r.table.padEnd(40)} ${r.absent ? "absent" : `sampled=${r.sampled} violations=${r.violations}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`}`);
    return results.some((r) => r.violations > 0) ? 1 : 0;
  } catch {
    // Connection and query errors can carry URLs or row data; none is echoed.
    error("The census failed. Check the database configuration and that the schema is migrated.");
    return 1;
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void censusMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
