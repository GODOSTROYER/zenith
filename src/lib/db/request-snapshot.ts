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
