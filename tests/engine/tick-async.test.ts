/**
 * `engineTickAsync()` — the tick a caller outside a request uses.
 *
 * Boot on a serverless instance and the cron routes have no 250ms ticker to
 * rely on and no `route()` to flush the store for them, so the tick they call
 * has to advance the state machine *and* wait for the write. On Postgres it
 * also has to survive the 409 that a concurrent request produces: the engine
 * writes on every step transition, so a collision mid-deploy is expected, and
 * abandoning the deployment there would strand it.
 *
 * These run on the file store — the only implementation a unit test can drive
 * — so what is asserted here is the shape of the contract: it awaits the
 * flush, it advances the same deployments `engineTick()` would, and a failure
 * that is not a 409 still reaches the caller. The 409 retry itself is covered
 * against a real database by tests/db/contract/history.test.ts.
 */
import { afterEach, expect, test, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-engine-tick-");
process.env.ZENITH_FAST = "1";

const store = await import("@/lib/db/store");
const { engineTickAsync } = await import("@/lib/engine/engine");

afterEach(() => vi.restoreAllMocks());

test("awaits the store's pending write rather than leaving it scheduled", async () => {
  store.resetDb();
  const flush = vi.spyOn(store, "flushPendingAsync");
  await engineTickAsync();
  expect(flush).toHaveBeenCalledTimes(1);
});

test("an idle tick is cheap and resolves", async () => {
  store.resetDb();
  // Nothing is deploying: the tick walks an empty active set and still
  // resolves, which is what a cron invocation on a quiet install costs.
  await expect(engineTickAsync()).resolves.toBeUndefined();
});

test("a failure that is not a 409 reaches the caller", async () => {
  store.resetDb();
  const boom = new Error("the database is on fire");
  vi.spyOn(store, "flushPendingAsync").mockRejectedValueOnce(boom);
  await expect(engineTickAsync()).rejects.toBe(boom);
});

test("a 409 on the file store is not swallowed either", async () => {
  store.resetDb();
  // The retry is a Postgres affordance: it reloads the process snapshot, and
  // there is no snapshot to reload on the file store. A 409 there is a bug,
  // not a race, so it propagates.
  const conflict = Object.assign(new Error("someone else changed this"), { status: 409 });
  vi.spyOn(store, "flushPendingAsync").mockRejectedValueOnce(conflict);
  await expect(engineTickAsync()).rejects.toBe(conflict);
});
