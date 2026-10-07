/**
 * A migrated, empty scratch PostgreSQL database with an explicit lifecycle, for suites that must not touch the shared
 * `platform` schema (a recovery-epoch bump lifts every fence counter). Needs ZENITH_TEST_PLATFORM_PG_URL and CREATEDB.
 */
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { withScratchDatabase } from "./harness";

export interface ScratchDb {
  url: string;
  /** a handle on the migrated database; `reopen` gives another pool (the first stays open) */
  db: PlatformDbHandle;
  close(): Promise<void>;
}

/** An EMPTY database: nothing migrated, no schema. The restore target. */
export async function openEmptyScratchDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  let release!: () => void;
  let ready!: (url: string) => void;
  const url = new Promise<string>((resolve) => { ready = resolve; });
  const done = new Promise<void>((resolve) => { release = resolve; });
  const holder = withScratchDatabase(async (u) => { ready(u); await done; });
  const resolved = await url;
  return { url: resolved, close: async () => { release(); await holder; } };
}

/** A migrated database (the shape the platform runs in). */
export async function openMigratedScratchDatabase(): Promise<ScratchDb> {
  const empty = await openEmptyScratchDatabase();
  const db = await openPlatformDb({ kind: "postgres", url: empty.url, migrate: true, max: 4 });
  return { url: empty.url, db, close: async () => { await db.close(); await empty.close(); } };
}
