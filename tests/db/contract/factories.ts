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

export const storeFactories: StoreFactory[] = [
  {
    name: "FileStore",
    create: async () => (await import("@/lib/db/file-store")).FileStore,
  },
];

/** Resolve every factory into `{ name, store }` rows for `describe.each`. */
export async function loadStores(): Promise<{ name: string; store: Store }[]> {
  return Promise.all(
    storeFactories.map(async (f) => ({ name: f.name, store: await f.create() }))
  );
}
