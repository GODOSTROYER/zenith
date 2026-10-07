/**
 * Operator trigger for the `data-minimize` critical job (PROD-OPS-06), for installs without the Temporal
 * critical-maintenance schedule (the schedule runs the same pass every minute).
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/data-minimize.ts
 *
 * One bounded pass under the schedule's own lease and run record (`critical-job:data-minimize`): sealed job and
 * request result bodies older than ZENITH_RESULT_RETENTION_HOURS (default 72) are removed, and expired agent
 * uploads are swept. Prints counts only. Exit 0 ok (including skipped or busy), 1 failure, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { countsOf, runCriticalJob } from "@/lib/platform/critical-jobs";
import { minimizePass } from "@/lib/sensitivedata/minimize";

export async function dataMinimizeMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  if (args.length > 0) { error("Usage: npx tsx --env-file-if-exists=.env.local scripts/data-minimize.ts"); return 2; }
  let db: PlatformDb | undefined;
  try {
    const config = platformDbConfigFromEnv(env);
    if (config.kind !== "postgres" || !config.url) { error("A Postgres platform store is required (ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL)."); return 1; }
    db = await openPlatformDb({ kind: "postgres", url: config.url, max: 1, migrate: false });
    const handle = db;
    const run = await runCriticalJob(handle, "data-minimize", "fallback", async () => {
      const value = await minimizePass(handle, { env });
      return { value, performed: true, counts: countsOf(value) };
    });
    if (run.status === "ok") output(JSON.stringify(run.value));
    else output(JSON.stringify({ status: run.status }));
    return 0;
  } catch {
    // Connection and query errors can carry URLs or row data; none is echoed.
    error("Data minimization failed. Check the platform store configuration and that the schema is migrated.");
    return 1;
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void dataMinimizeMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
