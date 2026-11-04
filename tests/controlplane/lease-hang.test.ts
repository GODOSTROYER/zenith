/**
 * `withLease` must give up BEFORE the lease can lapse even when a renewal
 * never returns (a stalled connection or an exhausted pool). Previously the
 * in-flight guard skipped every later tick, so the staleness check never ran
 * and the worker kept acting on a lease the database had already expired.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { withLease } from "@/lib/controlplane/leases";
import { LeaseLostError, type PlatformDb, type Sql } from "@/lib/controlplane/types";

let real: PlatformDbHandle;

beforeAll(async () => {
  real = await openPlatformDb({ kind: "pglite" });
});

afterAll(async () => {
  await real.close();
});

/** Delegates to the real store, except that lease renewals hang forever once armed. */
function hangingRenewals(db: PlatformDb): PlatformDb & { arm(): void } {
  let armed = false;
  const isRenewal = (text: string) => /update platform\.leases\s+set expires_at = greatest/.test(text);
  const wrap = (sql: Sql): Sql => ({
    query: (text, params) => (armed && isRenewal(text) ? new Promise(() => {}) : sql.query(text, params)),
    tx: (fn) => sql.tx((inner) => fn(wrap(inner))),
  });
  const inner = wrap(db);
  return { ...inner, kind: db.kind, close: () => db.close(), arm: () => void (armed = true) };
}

describe("withLease with a renewal that never returns", () => {
  it("aborts with LeaseLostError before the ttl elapses", async () => {
    const db = hangingRenewals(real);
    const ttlMs = 1_500;
    const started = performance.now();
    const outcome = await withLease(db, { scope: "env:hang-test", holder: "worker-1", ttlMs, renewEveryMs: 50 }, async (_lease, signal) => {
      db.arm();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "finished";
    }).catch((e: unknown) => e);
    const elapsed = performance.now() - started;

    expect(outcome).toBeInstanceOf(LeaseLostError);
    // must stop at ~2/3 ttl, and certainly before the lease itself lapses
    expect(elapsed).toBeLessThan(ttlMs);
  });
});
