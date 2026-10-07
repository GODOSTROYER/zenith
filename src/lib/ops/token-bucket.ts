/**
 * Token buckets keyed by tenant (PROD-OPS-02). Pure and clock-injected.
 *
 * `TokenBucketLimiter` holds at most `maxKeys` buckets, so the key space an
 * attacker controls can never grow memory without bound:
 *   - a bucket that has been idle long enough to refill completely is
 *     indistinguishable from a fresh one, so those are the only ones evicted;
 *   - when the table is full of non-refilled buckets, a NEW key shares one
 *     overflow bucket instead of getting a free full burst. Existing keys keep
 *     their own state, so rotating identities cannot reset another tenant.
 *
 * Leaf module (no imports): safe in the edge runtime.
 */

export interface BucketSpec {
  /** tokens added per second */
  ratePerSec: number;
  /** maximum stored tokens (also the largest single burst) */
  burst: number;
}

export type TakeResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number; remaining: number };

interface Bucket { tokens: number; at: number; spec: BucketSpec }

export function assertSpec(spec: BucketSpec): void {
  if (!Number.isFinite(spec.ratePerSec) || spec.ratePerSec <= 0 || spec.ratePerSec > 1_000_000) throw new RangeError("ratePerSec must be in (0, 1e6]");
  if (!Number.isFinite(spec.burst) || spec.burst < 1 || spec.burst > 1_000_000) throw new RangeError("burst must be in [1, 1e6]");
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private overflow: Bucket | undefined;
  constructor(
    private readonly defaults: BucketSpec,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now
  ) {
    assertSpec(defaults);
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be a positive integer");
  }

  get size(): number { return this.buckets.size; }

  /** Take `cost` tokens for `key`. `spec` overrides the defaults for this key (tenant quota or weight). */
  take(key: string, cost = 1, spec: BucketSpec = this.defaults): TakeResult {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      this.evictRefilled(t);
      if (this.buckets.size >= this.maxKeys) bucket = this.overflow ??= { tokens: spec.burst, at: t, spec };
      else {
        bucket = { tokens: spec.burst, at: t, spec };
        this.buckets.set(key, bucket);
      }
    } else {
      // Refresh recency (Map iteration order) so eviction scans oldest-first.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      if (bucket.spec.ratePerSec !== spec.ratePerSec || bucket.spec.burst !== spec.burst) {
        this.refill(bucket, t);
        bucket.spec = spec;
        bucket.tokens = Math.min(bucket.tokens, spec.burst);
      }
    }
    this.refill(bucket, t);
    if (cost > bucket.spec.burst) return { ok: false, retryAfterMs: 60_000, remaining: bucket.tokens };
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, remaining: bucket.tokens };
    }
    return { ok: false, retryAfterMs: Math.ceil(((cost - bucket.tokens) / bucket.spec.ratePerSec) * 1000), remaining: bucket.tokens };
  }

  private refill(b: Bucket, t: number): void {
    const dt = Math.max(0, t - b.at) / 1000;
    b.tokens = Math.min(b.spec.burst, b.tokens + dt * b.spec.ratePerSec);
    b.at = t;
  }

  /** Drop buckets that would be full by now; scans oldest-first and stops at the first live one. */
  private evictRefilled(t: number): void {
    if (this.buckets.size < this.maxKeys) return;
    for (const [key, b] of this.buckets) {
      const idleSec = Math.max(0, t - b.at) / 1000;
      if (b.tokens + idleSec * b.spec.ratePerSec >= b.spec.burst) this.buckets.delete(key);
      else break;
    }
  }
}
