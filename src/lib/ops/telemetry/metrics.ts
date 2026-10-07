/**
 * A small, dependency-free metrics registry that speaks both wire formats the
 * observability stack needs (PROD-OPS-02): Prometheus text exposition and
 * OpenTelemetry OTLP/HTTP JSON. No `@opentelemetry/*` package is installed, so
 * the data model here is the OTel one (cumulative sums, gauges, explicit-bucket
 * histograms with the same attribute names) and `otlp.ts` serializes it.
 *
 * Bounds, because telemetry must never become the outage:
 *   - each metric keeps at most `maxSeries` label combinations; further new
 *     combinations fold into one `_overflow` series and are counted;
 *   - label values are truncated to 128 characters;
 *   - tenant labels come from `TenantLabeler`, which admits at most N distinct
 *     workspaces and reports everyone else as `other`.
 *
 * Nothing here throws into a caller: instrument calls are wrapped so a bad
 * label can at worst drop a sample.
 */

export type LabelValues = Readonly<Record<string, string | number | boolean | undefined>>;

const MAX_LABEL_CHARS = 128;
const OVERFLOW = "_overflow";

const clean = (v: string | number | boolean | undefined): string => {
  const s = v === undefined ? "" : String(v);
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s;
};

interface Series { labels: string[]; value: number; buckets?: number[]; sum?: number; count?: number }

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricMeta { name: string; help: string; kind: MetricKind; labelNames: readonly string[]; unit?: string; buckets?: readonly number[] }

abstract class Metric {
  protected readonly series = new Map<string, Series>();
  constructor(readonly meta: MetricMeta, protected readonly registry: MetricsRegistry, private readonly maxSeries: number) {}

  protected seriesFor(values: LabelValues): Series {
    const labels = this.meta.labelNames.map((n) => clean(values[n]));
    const key = labels.join("\u0000");
    let s = this.series.get(key);
    if (s) return s;
    if (this.series.size >= this.maxSeries) {
      this.registry.noteDropped("metric_series");
      const overflowLabels = this.meta.labelNames.map(() => OVERFLOW);
      const overflowKey = overflowLabels.join("\u0000");
      s = this.series.get(overflowKey);
      if (!s) { s = this.fresh(overflowLabels); this.series.set(overflowKey, s); }
      return s;
    }
    s = this.fresh(labels);
    this.series.set(key, s);
    return s;
  }

  protected fresh(labels: string[]): Series {
    return { labels, value: 0 };
  }

  snapshot(): { meta: MetricMeta; series: Series[] } {
    return { meta: this.meta, series: [...this.series.values()].map((s) => ({ ...s, labels: [...s.labels], ...(s.buckets ? { buckets: [...s.buckets] } : {}) })) };
  }

  reset(): void { this.series.clear(); }
}

export class Counter extends Metric {
  inc(values: LabelValues = {}, by = 1): void {
    try { if (by > 0 && Number.isFinite(by)) this.seriesFor(values).value += by; } catch { /* telemetry never throws */ }
  }
}

export class Gauge extends Metric {
  set(values: LabelValues, value: number): void {
    try { if (Number.isFinite(value)) this.seriesFor(values).value = value; } catch { /* telemetry never throws */ }
  }
  /** Replace every series (used for sampled snapshots such as queue depth per tenant). */
  replace(entries: readonly { labels: LabelValues; value: number }[]): void {
    this.series.clear();
    for (const e of entries) this.set(e.labels, e.value);
  }
}

export class Histogram extends Metric {
  private readonly bounds: readonly number[];
  constructor(meta: MetricMeta, registry: MetricsRegistry, maxSeries: number) {
    super(meta, registry, maxSeries);
    this.bounds = meta.buckets ?? DEFAULT_BUCKETS;
  }
  protected override fresh(labels: string[]): Series {
    return { labels, value: 0, buckets: new Array(this.bounds.length + 1).fill(0), sum: 0, count: 0 };
  }
  observe(values: LabelValues, value: number): void {
    try {
      if (!Number.isFinite(value) || value < 0) return;
      const s = this.seriesFor(values);
      let i = this.bounds.findIndex((b) => value <= b);
      if (i < 0) i = this.bounds.length;
      s.buckets![i]++;
      s.sum! += value;
      s.count!++;
    } catch { /* telemetry never throws */ }
  }
}

/** Seconds; covers a fast API hit through a long activity. */
export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

export class MetricsRegistry {
  private readonly metrics = new Map<string, Counter | Gauge | Histogram>();
  readonly startedAtMs = Date.now();
  private readonly dropped = new Map<string, number>();
  constructor(private readonly maxSeries = 2000) {}

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.define(name, () => new Counter({ name, help, kind: "counter", labelNames }, this, this.maxSeries)) as Counter;
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.define(name, () => new Gauge({ name, help, kind: "gauge", labelNames }, this, this.maxSeries)) as Gauge;
  }
  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = DEFAULT_BUCKETS, unit = "s"): Histogram {
    return this.define(name, () => new Histogram({ name, help, kind: "histogram", labelNames, buckets, unit }, this, this.maxSeries)) as Histogram;
  }

  private define<T extends Counter | Gauge | Histogram>(name: string, make: () => T): T {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid metric name ${name}`);
    const existing = this.metrics.get(name);
    if (existing) return existing as T;
    const created = make();
    this.metrics.set(name, created);
    return created;
  }

  noteDropped(signal: string): void { this.dropped.set(signal, (this.dropped.get(signal) ?? 0) + 1); }
  droppedCount(signal: string): number { return this.dropped.get(signal) ?? 0; }

  snapshot(): { meta: MetricMeta; series: Series[] }[] {
    const out = [...this.metrics.values()].map((m) => m.snapshot());
    if (this.dropped.size) {
      out.push({
        meta: { name: "zenith_telemetry_dropped_total", help: "Telemetry samples dropped by a bound (series cap or buffer cap).", kind: "counter", labelNames: ["signal"] },
        series: [...this.dropped].map(([signal, value]) => ({ labels: [signal], value })),
      });
    }
    return out;
  }

  /** Prometheus text exposition format 0.0.4. */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const { meta, series } of this.snapshot()) {
      lines.push(`# HELP ${meta.name} ${meta.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
      lines.push(`# TYPE ${meta.name} ${meta.kind}`);
      const label = (values: string[], extra?: string): string => {
        const parts = meta.labelNames.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
        if (extra) parts.push(extra);
        return parts.length ? `{${parts.join(",")}}` : "";
      };
      for (const s of series) {
        if (meta.kind === "histogram") {
          const bounds = meta.buckets ?? DEFAULT_BUCKETS;
          let cumulative = 0;
          bounds.forEach((b, i) => {
            cumulative += s.buckets![i];
            lines.push(`${meta.name}_bucket${label(s.labels, `le="${b}"`)} ${cumulative}`);
          });
          cumulative += s.buckets![bounds.length];
          lines.push(`${meta.name}_bucket${label(s.labels, 'le="+Inf"')} ${cumulative}`);
          lines.push(`${meta.name}_sum${label(s.labels)} ${s.sum}`);
          lines.push(`${meta.name}_count${label(s.labels)} ${s.count}`);
        } else lines.push(`${meta.name}${label(s.labels)} ${s.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    for (const m of this.metrics.values()) m.reset();
    this.dropped.clear();
  }
}

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

/** Admits at most `limit` distinct tenant ids as metric labels; everyone else is `other`. */
export class TenantLabeler {
  private readonly seen = new Set<string>();
  constructor(private readonly limit = 200) {}
  label(workspaceId: string | undefined): string {
    if (!workspaceId) return "none";
    if (this.seen.has(workspaceId)) return workspaceId;
    if (this.seen.size < this.limit && /^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId)) { this.seen.add(workspaceId); return workspaceId; }
    return "other";
  }
  reset(): void { this.seen.clear(); }
}

const key = Symbol.for("zenith.ops.metrics.v1");
type G = typeof globalThis & { [key]?: { registry: MetricsRegistry; tenants: TenantLabeler } };

/** Process-wide registry that survives dev hot-reload. */
export function metricsRegistry(): MetricsRegistry {
  const g = globalThis as G;
  return (g[key] ??= { registry: new MetricsRegistry(), tenants: new TenantLabeler() }).registry;
}
export function tenantLabeler(): TenantLabeler {
  const g = globalThis as G;
  return (g[key] ??= { registry: new MetricsRegistry(), tenants: new TenantLabeler() }).tenants;
}
