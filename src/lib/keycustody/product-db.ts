/**
 * The PRODUCT database handle for maintenance that touches `public.*` / `agent.*` tables (the vault, agent
 * uploads), as opposed to the platform control store. `scripts/vault-rewrap.ts` has always used
 * `SUPABASE_DB_URL` for these; the durable maintenance jobs use the same rule:
 *
 *  - not `ZENITH_STORE=postgres`        -> undefined (the file store; only the operator CLI can rewrap it)
 *  - no `SUPABASE_DB_URL`               -> undefined
 *  - same database as the platform store -> the platform handle itself (one pool)
 *  - otherwise                          -> a small separate pool, cached on globalThis, never migrated
 *
 * Never logs or returns the URL.
 */
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";

type G = typeof globalThis & { __zenithProductMaintenanceDb?: Promise<Sql> };

export async function productSql(platform: Sql, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Sql | undefined> {
  if (env.ZENITH_STORE !== "postgres") return undefined;
  const url = env.SUPABASE_DB_URL?.trim();
  if (!url) return undefined;
  let platformUrl: string | undefined;
  try { platformUrl = platformDbConfigFromEnv(env).url; } catch { platformUrl = undefined; }
  if (platformUrl === url) return platform;
  const g = globalThis as G;
  if (!g.__zenithProductMaintenanceDb) {
    const opening = openPlatformDb({ kind: "postgres", url, max: 2, migrate: false });
    g.__zenithProductMaintenanceDb = opening;
    opening.catch(() => { if (g.__zenithProductMaintenanceDb === opening) delete g.__zenithProductMaintenanceDb; });
  }
  return g.__zenithProductMaintenanceDb;
}
