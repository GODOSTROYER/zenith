/** Legacy operator entrypoint; now applies the complete platform migration ledger. */
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db/open";
import { migratePlatformDb } from "@/lib/controlplane/db/migrator";

async function main(): Promise<void> {
  const config = platformDbConfigFromEnv();
  const db = await openPlatformDb({ ...config, migrate: false });
  try {
    await migratePlatformDb(db);
    process.stdout.write("Platform migrations applied, including GitHub source schema.\n");
  } finally { await db.close(); }
}
void main().catch(() => {
  process.stderr.write("GitHub source schema setup failed; check platform database configuration.\n");
  process.exitCode = 1;
});
