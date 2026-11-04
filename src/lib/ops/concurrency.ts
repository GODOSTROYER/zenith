/**
 * In-flight limits (PROD-OPS-02): a global ceiling plus a per-tenant ceiling.
 *
 * Refusal, never waiting: a request that cannot start now is answered 429/503
 * with Retry-After, so no queue of parked requests can grow in memory. Every
 * lease is released by its holder, and any lease older than `leaseTtlMs` is
 * reclaimed on the next acquire, so a handler that never returns cannot hold a
 * slot forever. Counts are deleted at zero, so the table is bounded by the
 * number of live leases (which is bounded by `globalMax`).
 */

export type GateDecision =
  | { ok: true; release: () => void }
  | { ok: false; scope: "global" | "tenant" };

interface Lease { key: string; at: number }

export class ConcurrencyGate {
  private readonly leases = new Map<number, Lease>();
  private readonly perKey = new Map<string, number>();
  private next = 1;
  constructor(
    private readonly globalMax: number,
    private readonly leaseTtlMs = 15 * 60_000,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(globalMax) || globalMax < 1) throw new RangeError("globalMax must be a positive integer");
  }

  get inFlight(): number { return this.leases.size; }
  inFlightFor(key: string): number { return this.perKey.get(key) ?? 0; }

  tryAcquire(key: string, perKeyMax: number): GateDecision {
    this.reclaim();
    if (this.leases.size >= this.globalMax) return { ok: false, scope: "global" };
    if ((this.perKey.get(key) ?? 0) >= perKeyMax) return { ok: false, scope: "tenant" };
    const id = this.next++;
    this.leases.set(id, { key, at: this.now() });
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.drop(id);
      },
    };
  }

  private drop(id: number): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    const n = (this.perKey.get(lease.key) ?? 1) - 1;
    if (n <= 0) this.perKey.delete(lease.key);
    else this.perKey.set(lease.key, n);
  }

  private reclaim(): void {
    const cutoff = this.now() - this.leaseTtlMs;
    for (const [id, lease] of this.leases) {
      if (lease.at > cutoff) break; // Map iterates in insertion (== time) order
      this.drop(id);
    }
  }
}
