/**
 * Service level indicators from the OpenTelemetry metrics the control plane already emits (PROD-OPS-02 catalog)
 * and from durable rows (PROD-OBS-04 scheduler records, platform.operations). Pure functions over a registry
 * snapshot: no I/O, no new instruments.
 */
import type { MetricsRegistry } from "@/lib/ops/telemetry/metrics";

export interface GoodTotal { good: number; total: number }

type Snapshot = ReturnType<MetricsRegistry["snapshot"]>;

const find = (snap: Snapshot, name: string) => snap.find((m) => m.meta.name === name);

/** Availability counts: every API request, and those that did not fail with a 5xx. 429 is the caller's own quota. */
export function apiAvailabilityFromSnapshot(snap: Snapshot): GoodTotal {
  const m = find(snap, "zenith_api_requests_total");
  if (!m) return { good: 0, total: 0 };
  const idx = m.meta.labelNames.indexOf("status_class");
  let good = 0;
  let total = 0;
  for (const s of m.series) {
    total += s.value;
    if (s.labels[idx] !== "5xx") good += s.value;
  }
  return { good, total };
}

/**
 * Requests answered within `thresholdSeconds`, from the histogram buckets. The threshold is rounded DOWN to the
 * nearest bucket bound, so the count never claims a request was fast when its bucket straddles the threshold.
 */
export function apiLatencyFromSnapshot(snap: Snapshot, thresholdSeconds: number): GoodTotal & { effectiveThresholdSeconds: number | null } {
  const m = find(snap, "zenith_api_request_duration_seconds");
  const bounds = m?.meta.buckets;
  if (!m || !bounds) return { good: 0, total: 0, effectiveThresholdSeconds: null };
  let upto = -1;
  for (let i = 0; i < bounds.length; i++) if (bounds[i] <= thresholdSeconds) upto = i;
  let good = 0;
  let total = 0;
  for (const s of m.series) {
    const b = s.buckets ?? [];
    total += s.count ?? 0;
    for (let i = 0; i <= upto; i++) good += b[i] ?? 0;
  }
  return { good, total, effectiveThresholdSeconds: upto >= 0 ? bounds[upto] : null };
}

/**
 * Process-local latency quantile estimate (upper bound of the bucket holding the quantile). Shown next to the
 * ratio so an operator sees "p95 is about X" for this process; budgets use the ratio, not this estimate.
 */
export function apiLatencyQuantileFromSnapshot(snap: Snapshot, q: number): number | null {
  const m = find(snap, "zenith_api_request_duration_seconds");
  const bounds = m?.meta.buckets;
  if (!m || !bounds) return null;
  const merged = new Array<number>(bounds.length + 1).fill(0);
  let total = 0;
  for (const s of m.series) {
    total += s.count ?? 0;
    (s.buckets ?? []).forEach((n, i) => { merged[i] += n; });
  }
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < merged.length; i++) {
    seen += merged[i];
    if (seen >= rank) return i < bounds.length ? bounds[i] : Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** Exact quantile of a sample list (used by the capacity test and tests). Nearest-rank. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export const ratioOf = (g: GoodTotal): number | null => (g.total > 0 ? g.good / g.total : null);

/** Difference of two cumulative readings; a counter reset (process restart) yields the new reading. */
export function counterDelta(previous: GoodTotal | undefined, current: GoodTotal): GoodTotal {
  if (!previous || current.total < previous.total || current.good < previous.good) return { ...current };
  return { good: current.good - previous.good, total: current.total - previous.total };
}
