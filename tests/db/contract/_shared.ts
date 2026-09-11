/**
 * The contract suite's shared prelude, so a second file is three lines.
 *
 *     import { contractStores } from "./_shared";
 *     describe.each(contractStores)("$name", ({ store }) => { ... });
 *
 * The order here is the whole point: `tempDataDir()` must run before any
 * application import, and `./factories.ts` imports its implementations lazily
 * inside `create()` for exactly that reason — so the awaited `loadStores()`
 * below is the first thing that touches application code, and it does so after
 * `ZENITH_DATA` is pinned to this run's own directory.
 *
 * `store-contract.test.ts` does the same three steps inline and predates this
 * file; it is left alone on purpose. New contract files should import from
 * here.
 */
import { tempDataDir } from "../../_support/data-dir";
import { loadStores } from "./factories";

// MUST precede every application import. See above.
tempDataDir("zenith-store-contract-");

/** `{ name, store }` for every enabled implementation, ready for `describe.each`. */
export const contractStores = await loadStores();

export { CONTRACT_PREFIX, cleanupPostgresContract, postgresContractEnabled } from "./factories";
