/**
 * PROD-OPS-02: per-tenant token buckets and in-flight gates. Pure, clock-injected, no engine.
 */
import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@/lib/ops/token-bucket";
import { ConcurrencyGate } from "@/lib/ops/concurrency";
import { BackpressureError, backpressureBody, backpressureResponse, clampRetryAfter, isBackpressureError } from "@/lib/ops/errors";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("TokenBucketLimiter", () => {
  it("allows a burst, then refuses with a retry hint that matches the refill rate", () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 2, burst: 4 }, 100, c.now);
    for (let i = 0; i < 4; i++) expect(limiter.take("ws_a").ok).toBe(true);
    const refused = limiter.take("ws_a");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBe(500);
    c.advance(500);
    expect(limiter.take("ws_a").ok).toBe(true);
    expect(limiter.take("ws_a").ok).toBe(false);
  });

  it("isolates tenants: one tenant exhausting its bucket does not touch another's", () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 3 }, 100, c.now);
    for (let i = 0; i < 10; i++) limiter.take("noisy");
    expect(limiter.take("noisy").ok).toBe(false);
    expect(limiter.take("quiet").ok).toBe(true);
  });

  it("honours a per-tenant spec (weight or quota) and caps stored tokens when the spec shrinks", () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 2 }, 100, c.now);
    const big = { ratePerSec: 10, burst: 20 };
    for (let i = 0; i < 20; i++) expect(limiter.take("heavy", 1, big).ok).toBe(true);
    expect(limiter.take("heavy", 1, big).ok).toBe(false);
    // Shrinking the quota takes effect immediately.
    const small = { ratePerSec: 1, burst: 1 };
    c.advance(60_000);
    expect(limiter.take("heavy", 1, small).ok).toBe(true);
    expect(limiter.take("heavy", 1, small).ok).toBe(false);
  });

  it("refuses a request larger than the burst outright", () => {
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 3 }, 10, clock().now);
    expect(limiter.take("a", 4).ok).toBe(false);
  });

  it("is bounded: refilled buckets are evicted, and new keys share an overflow bucket when none can be", () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 5 }, 3, c.now);
    for (const k of ["a", "b", "c"]) limiter.take(k, 5); // three drained buckets fill the table
    expect(limiter.size).toBe(3);
    // A fourth identity gets the shared overflow bucket, not a fresh burst and not a new row.
    const results = Array.from({ length: 8 }, (_, i) => limiter.take(`new-${i}`).ok);
    expect(limiter.size).toBe(3);
    expect(results.filter(Boolean).length).toBe(5); // one shared burst of 5, not eight fresh ones
    // Once the old buckets have refilled they are evictable and a new key gets its own bucket.
    c.advance(10_000);
    expect(limiter.take("later").ok).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it("rejects nonsense configuration", () => {
    expect(() => new TokenBucketLimiter({ ratePerSec: 0, burst: 1 })).toThrow();
    expect(() => new TokenBucketLimiter({ ratePerSec: 1, burst: 0 })).toThrow();
    expect(() => new TokenBucketLimiter({ ratePerSec: 1, burst: 1 }, 0)).toThrow();
  });
});

describe("ConcurrencyGate", () => {
  it("enforces the global ceiling and the per-key ceiling, and release is idempotent", () => {
    const gate = new ConcurrencyGate(3);
    const a1 = gate.tryAcquire("a", 2);
    const a2 = gate.tryAcquire("a", 2);
    expect(a1.ok && a2.ok).toBe(true);
    expect(gate.tryAcquire("a", 2)).toEqual({ ok: false, scope: "tenant" });
    const b1 = gate.tryAcquire("b", 2);
    expect(b1.ok).toBe(true);
    expect(gate.tryAcquire("c", 2)).toEqual({ ok: false, scope: "global" });
    if (a1.ok) { a1.release(); a1.release(); }
    expect(gate.inFlight).toBe(2);
    expect(gate.inFlightFor("a")).toBe(1);
    expect(gate.tryAcquire("c", 2).ok).toBe(true);
  });

  it("reclaims a lease that was never released so a hung handler cannot hold a slot forever", () => {
    const c = clock();
    const gate = new ConcurrencyGate(1, 60_000, c.now);
    expect(gate.tryAcquire("a", 1).ok).toBe(true);
    expect(gate.tryAcquire("a", 1).ok).toBe(false);
    c.advance(60_001);
    expect(gate.tryAcquire("a", 1).ok).toBe(true);
    expect(gate.inFlight).toBe(1);
  });

  it("holds no per-key state at zero", () => {
    const gate = new ConcurrencyGate(10);
    const lease = gate.tryAcquire("tenant", 5);
    if (lease.ok) lease.release();
    expect(gate.inFlightFor("tenant")).toBe(0);
    expect(gate.inFlight).toBe(0);
  });
});

describe("BackpressureError", () => {
  it("maps codes to 429 (the caller's own quota) or 503 (platform or operator shedding) with a bounded Retry-After", () => {
    expect(new BackpressureError("rate_limited", "api", "m", 2).status).toBe(429);
    expect(new BackpressureError("concurrency_exceeded", "dispatch", "m", 2).status).toBe(429);
    expect(new BackpressureError("queue_full", "runner_queue", "m", 2).status).toBe(429);
    expect(new BackpressureError("overloaded", "api", "m", 2).status).toBe(503);
    expect(new BackpressureError("maintenance_read_only", "maintenance", "m", 2).status).toBe(503);
    expect(new BackpressureError("maintenance_dispatch_paused", "maintenance", "m", 2).status).toBe(503);
    expect(clampRetryAfter(0)).toBe(1);
    expect(clampRetryAfter(0.2)).toBe(1);
    expect(clampRetryAfter(1.1)).toBe(2);
    expect(clampRetryAfter(99_999)).toBe(3600);
    expect(clampRetryAfter(Number.NaN)).toBe(1);
  });

  it("answers with the platform error shape and a Retry-After header, never a 500", async () => {
    const error = new BackpressureError("rate_limited", "api", "Slow down.", 7, "ws_1");
    expect(isBackpressureError(error)).toBe(true);
    expect(isBackpressureError(new Error("x"))).toBe(false);
    const res = backpressureResponse(error);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ReturnType<typeof backpressureBody>;
    expect(body.error).toMatchObject({ code: "rate_limited", message: "Slow down.", retryAfterSec: 7 });
    expect(body.error.fix).toContain("7 seconds");
    // The tenant id is a metric/log dimension, not response content.
    expect(JSON.stringify(body)).not.toContain("ws_1");
  });
});
