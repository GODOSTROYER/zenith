/**
 * The store implementations the contract suite runs against.
 *
 * Nothing here may import application code at module scope: the contract test
 * files call `tempDataDir()` before they import anything, and the file store
 * pins `ZENITH_DATA` on first import. Each factory therefore imports its
 * implementation lazily, inside `create()`.
 *
 * Today the table has one row. A second (`PostgresStore`) is appended here and
 * nowhere else — `describe.each(await loadStores())` picks it up.
 */
import type { Store } from "@/lib/db/types";

export interface StoreFactory {
  /** Shown in the test name. */
  name: string;
  /** Build (or fetch) the store. Imports the implementation lazily. */
  create: () => Promise<Store>;
}

/**
 * Is the Postgres row in play?
 *
 * Three conditions, all required. The keys say a project exists;
 * `ZENITH_CONTRACT_POSTGRES=1` says you meant it — because this factory runs
 * against a **real** Supabase project, not a fixture, and a contract suite that
 * silently started writing to whatever `.env.local` points at would be a very
 * unpleasant surprise. Unset anywhere (CI, a fresh clone, the default
 * `npx vitest run`) the table has exactly one row and nothing changes.
 */
export const postgresContractEnabled = (): boolean =>
  process.env.ZENITH_CONTRACT_POSTGRES === "1" &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * The workspace id prefix every row this suite writes carries, so `cleanup()`
 * can delete exactly what the run created and never anything else. Randomised
 * per process so two runs against one project cannot collide.
 */
export const CONTRACT_PREFIX = `contract-${Math.random().toString(36).slice(2, 10)}`;

/** Phase-2 tables, in reverse foreign-key order — what cleanup deletes from. */
const CONTRACT_TABLES = [
  "environments",
  "projects",
  "connections",
  "invites",
  "members",
  "workspaces",
  "workspace_versions",
] as const;

/**
 * Remove this run's rows. Called from `afterAll`; safe to call when the
 * Postgres row was never enabled, in which case it does nothing at all.
 */
export async function cleanupPostgresContract(): Promise<void> {
  if (!postgresContractEnabled()) return;
  const { pgClient } = await import("@/lib/db/postgres-store");
  const client = pgClient();
  for (const table of CONTRACT_TABLES) {
    const column = table === "workspaces" ? "id" : "workspace_id";
    await client.from(table).delete().like(column, `${CONTRACT_PREFIX}%`);
  }
}

export const storeFactories: StoreFactory[] = [
  {
    name: "FileStore",
    create: async () => (await import("@/lib/db/file-store")).FileStore,
  },
];

if (postgresContractEnabled())
  storeFactories.push({
    name: "PostgresStore",
    create: async () => {
      const store = await import("@/lib/db/postgres-store");
      // Load the process-global snapshot before the first `db()`: outside a
      // request there is no `route()` to prefetch, and the store's whole
      // premise is that the read already happened.
      //
      // Scoped to a synthetic member nobody is, so the snapshot starts empty:
      // `reset()` deletes what its snapshot loaded, and a suite primed with the
      // whole project would be one `reset()` away from emptying it.
      await store.primeProcessSnapshot({
        id: CONTRACT_PREFIX,
        email: `${CONTRACT_PREFIX}@contract.invalid`,
      });
      return store.PostgresStore;
    },
  });

/** Resolve every factory into `{ name, store }` rows for `describe.each`. */
export async function loadStores(): Promise<{ name: string; store: Store }[]> {
  return Promise.all(
    storeFactories.map(async (f) => ({ name: f.name, store: await f.create() }))
  );
}
