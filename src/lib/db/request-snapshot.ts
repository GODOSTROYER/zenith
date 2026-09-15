/**
 * The request-scoped store snapshot, on its own AsyncLocalStorage.
 *
 * Why it is not simply a field read off `server/request.ts`: the Postgres store
 * has to find the current request's snapshot on every `db()`, and importing
 * `server/request.ts` to ask would drag `next/server` (through
 * `server/errors.ts`) into a module that the migration script, the seed and the
 * contract tests all load under plain `tsx`. So the one thing the store needs
 * lives here, in a file whose only import is `node:async_hooks`.
 *
 * `RequestState.snapshot` in `server/request.ts` still carries the same object
 * — it is what the request scope is *for* — and `route()` sets both from one
 * value, so there is one snapshot per request and no way to get two.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Opaque here on purpose: the shape belongs to `./postgres-store`. */
const storage = new AsyncLocalStorage<unknown>();

/** Run `fn` with `snapshot` as the store's view for everything it awaits. */
export const runWithSnapshot = <T>(snapshot: unknown, fn: () => T): T =>
  storage.run(snapshot, fn);

/** The snapshot this call should read, or undefined outside a request. */
export const requestSnapshot = (): unknown => storage.getStore();

/**
 * Run `fn` with **no** snapshot in scope, whatever the caller inherited.
 *
 * For work that is not a caller's: the in-process scheduler
 * (`src/lib/server/cron.ts`) starts its interval from `boot()`, and `boot()` is
 * awaited by the first request that arrives — so the timer callback inherits
 * that request's async context, and any snapshot it was holding, for the life
 * of the process. A background pass must prime and read its *own* unfiltered
 * snapshot, never one request's tenant slice, so it leaves the context first.
 * `AsyncLocalStorage.exit()` is exactly that, and it is a no-op when there is
 * nothing to leave.
 */
export const outsideSnapshot = <T>(fn: () => T): T => storage.exit(fn);
