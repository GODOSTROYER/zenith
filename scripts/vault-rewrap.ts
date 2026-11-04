/**
 * Operator CLI: keys come only from the environment, never arguments or output.
 * Explicit workspace scope; --dry-run authenticates without changing any files.
 * Postgres uses SUPABASE_DB_URL and public.secrets, never the platform URL.
 * No DDL or dependency installation. Exit 0 success, 1 failure, 2 usage error.
 * Invoke with tsx --env-file-if-exists=.env.local scripts/vault-rewrap.ts.
 */
import { pathToFileURL } from "node:url";
import { env } from "@/lib/env";
import { openPlatformDb } from "@/lib/controlplane/db/open";
import type { PlatformDb } from "@/lib/controlplane/types";
import { FileVaultRewrap } from "@/lib/secrets/file-backend";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { postgresVaultRewrapStore } from "@/lib/secrets/pg-rewrap";
import { rewrapVault } from "@/lib/secrets/rewrap";

export async function vaultRewrapMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): Promise<number> {
  let workspaceId: string | undefined;
  let batchSize = 100;
  let dryRun = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg) || !["--workspace", "--batch-size", "--dry-run"].includes(arg)) return usage();
    seen.add(arg);
    if (arg === "--dry-run") dryRun = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--")) return usage();
      if (arg === "--workspace") workspaceId = value;
      else if (/^[0-9]+$/.test(value)) batchSize = Number(value);
      else return usage();
    }
  }
  if (!workspaceId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    return usage();
  let db: PlatformDb | undefined;
  try {
    const cipher = vaultCipherFromEnv();
    const storeConfig = env();
    let store = FileVaultRewrap;
    if (storeConfig.ZENITH_STORE === "postgres") {
      if (!storeConfig.SUPABASE_DB_URL) throw new Error("Missing product database configuration.");
      db = await openPlatformDb({ kind: "postgres", url: storeConfig.SUPABASE_DB_URL, max: 1, migrate: false });
      store = postgresVaultRewrapStore(db);
    }
    const counts = await rewrapVault(store, { workspaceId, batchSize, dryRun, cipher,
      onBatch: (progress) => output(JSON.stringify(progress)),
    });
    output(JSON.stringify(counts));
    return 0;
  } catch {
    error("Vault re-wrap failed. Check ZENITH_SECRET_KEY, ZENITH_VAULT_PREVIOUS_SECRET_KEYS, product store configuration and write access. Completed batches can be resumed; see docs/platform/operations/RECOVERY.md.");
    return 1;
  } finally {
    // Connection-close errors must not print a URI/password or hide a failure.
    if (db) await db.close().catch(() => undefined);
  }
  function usage(): number {
    error("Usage: npx tsx --env-file-if-exists=.env.local scripts/vault-rewrap.ts --workspace <id> [--batch-size 1..1000] [--dry-run]");
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void vaultRewrapMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
