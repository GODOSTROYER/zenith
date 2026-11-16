/**
 * OTLP/HTTP JSON serialization and a bounded push exporter (PROD-OPS-02).
 *
 *   ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT   collector base URL (https, or http to a loopback host).
 *                                        Unset = no push; the Prometheus route still works.
 *   ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE file holding a bearer token for the collector (optional;
 *                                        read from a file reference, never from the environment text)
 *   ZENITH_OTEL_EXPORT_INTERVAL_MS       push period, 1000..300000 (default 15000)
 *   ZENITH_OTEL_SERVICE_NAME             resource service.name (default zenith-control-plane)
 *   ZENITH_OTEL_TRACE_SAMPLE_RATIO       0..1 head sampling (default 0.1)
 *
 * The exporter is best effort by construction: one export in flight, a 5 s
 * timeout, no retry queue (metrics are cumulative so the next push carries the
 * state; spans live in a bounded ring that drops oldest). A collector outage
 * increments `zenith_telemetry_export_failures_total` and nothing else: it can
 * never slow or fail a request, a dispatch or a worker activity.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { metricsRegistry, type MetricMeta, DEFAULT_BUCKETS } from "./metrics";
import { opsMetrics } from "./catalog";
import { tracer, type FinishedSpan } from "./tracing";

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface OtlpAttr { key: string; value: OtlpValue }

const attr = (key: string, v: string | number | boolean): OtlpAttr => ({
  key,
  value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
});

const nanos = (ms: number): string => `${Math.round(ms)}000000`;

export function resourceAttributes(serviceName: string, instance: string, extra: Record<string, string> = {}): OtlpAttr[] {
  return [attr("service.name", serviceName), attr("service.instance.id", instance), ...Object.entries(extra).map(([k, v]) => attr(k, v))];
}

/** Attribute names follow OTel conventions where one exists; otherwise the metric's own label name. */
export function toOtlpMetrics(
  snapshot: readonly { meta: MetricMeta; series: { labels: string[]; value: number; buckets?: number[]; sum?: number; count?: number }[] }[],
  resource: OtlpAttr[], startedAtMs: number, nowMs: number
): unknown {
  const metrics = snapshot.filter((m) => m.series.length > 0).map(({ meta, series }) => {
    const points = series.map((s) => ({
      attributes: meta.labelNames.map((n, i) => attr(n, s.labels[i] ?? "")),
      startTimeUnixNano: nanos(startedAtMs),
      timeUnixNano: nanos(nowMs),
    }));
    const base = { name: meta.name, description: meta.help, ...(meta.unit ? { unit: meta.unit } : {}) };
    if (meta.kind === "gauge") return { ...base, gauge: { dataPoints: points.map((p, i) => ({ ...p, asDouble: series[i].value })) } };
    if (meta.kind === "counter") return { ...base, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: points.map((p, i) => ({ ...p, asDouble: series[i].value })) } };
    return {
      ...base,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: points.map((p, i) => ({
          ...p, count: String(series[i].count ?? 0), sum: series[i].sum ?? 0,
          bucketCounts: (series[i].buckets ?? []).map(String), explicitBounds: [...(meta.buckets ?? DEFAULT_BUCKETS)],
        })),
      },
    };
  });
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: { name: "zenith.ops", version: "1" }, metrics }] }] };
}

const KIND: Record<FinishedSpan["kind"], number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };

export function toOtlpTraces(spans: readonly FinishedSpan[], resource: OtlpAttr[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: resource },
      scopeSpans: [{
        scope: { name: "zenith.ops", version: "1" },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name, kind: KIND[s.kind],
          startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.endMs),
          attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
          status: { code: s.status === "error" ? 2 : s.status === "ok" ? 1 : 0, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
        })),
      }],
    }],
  };
}

/* -------------------------------- exporter -------------------------------- */

export interface ExporterConfig {
  endpoint: string;
  token?: string;
  intervalMs: number;
  serviceName: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Validate the collector URL; undefined when unset, throws a fixed message when unusable. */
export function exporterConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, readToken: (file: string) => string = readTokenFile): ExporterConfig | undefined {
  const raw = env.ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute URL."); }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT must use https (http only for a loopback collector).");
  if (url.username || url.password || url.search || url.hash) throw new Error("ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT must not carry credentials, a query or a fragment.");
  const intervalRaw = env.ZENITH_OTEL_EXPORT_INTERVAL_MS?.trim();
  const interval = intervalRaw ? Number(intervalRaw) : 15_000;
  if (!Number.isInteger(interval) || interval < 1000 || interval > 300_000) throw new Error("ZENITH_OTEL_EXPORT_INTERVAL_MS must be a whole number from 1000 to 300000.");
  const tokenFile = env.ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE?.trim();
  const service = env.ZENITH_OTEL_SERVICE_NAME?.trim() || "zenith-control-plane";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(service)) throw new Error("ZENITH_OTEL_SERVICE_NAME must be 1-64 letters, digits, '.', '_' or '-'.");
  return { endpoint: url.toString().replace(/\/+$/, ""), intervalMs: interval, serviceName: service, ...(tokenFile ? { token: readToken(tokenFile) } : {}) };
}

function readTokenFile(file: string): string {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error();
      const buf = Buffer.alloc(stat.size);
      readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8").trim();
      if (!text || /\s/.test(text)) throw new Error();
      return text;
    } finally { closeSync(fd); }
  } catch { throw new Error("ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE must name a readable regular file holding one token (1..4096 bytes)."); }
}

export type Post = (url: string, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<boolean>;

const defaultPost: Post = async (url, body, headers, timeoutMs) => {
  const res = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  return res.ok;
};

export class OtlpExporter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly instance = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  constructor(private readonly config: ExporterConfig, private readonly post: Post = defaultPost, private readonly now: () => number = Date.now) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One push of metrics and spans. Never throws; at most one in flight. */
  async flush(): Promise<{ metrics: boolean; traces: boolean } | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    try {
      const resource = resourceAttributes(this.config.serviceName, this.instance);
      const registry = metricsRegistry();
      const headers: Record<string, string> = { "content-type": "application/json", ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) };
      const metricsBody = JSON.stringify(toOtlpMetrics(registry.snapshot(), resource, registry.startedAtMs, this.now()));
      const spans = tracer().drain(512);
      const send = async (path: string, body: string, signal: string): Promise<boolean> => {
        try {
          const ok = await this.post(`${this.config.endpoint}${path}`, body, headers, 5000);
          if (!ok) opsMetrics().exportFailures.inc({ signal });
          return ok;
        } catch {
          opsMetrics().exportFailures.inc({ signal });
          return false;
        }
      };
      const metrics = await send("/v1/metrics", metricsBody, "metrics");
      const traces = spans.length ? await send("/v1/traces", JSON.stringify(toOtlpTraces(spans, resource)), "traces") : true;
      return { metrics, traces };
    } finally { this.busy = false; }
  }
}

const key = Symbol.for("zenith.ops.exporter.v1");
type G = typeof globalThis & { [key]?: { started: boolean; exporter?: OtlpExporter; error?: string } };

/**
 * Start the exporter once per process when the environment configures one.
 * Returns a fixed reason when the configuration is unusable so callers can log it; never throws.
 */
export function ensureTelemetryExport(): { running: boolean; error?: string } {
  const g = globalThis as G;
  const state = (g[key] ??= { started: false });
  if (state.started) return { running: !!state.exporter, ...(state.error ? { error: state.error } : {}) };
  state.started = true;
  try {
    const config = exporterConfigFromEnv();
    if (config) { state.exporter = new OtlpExporter(config); state.exporter.start(); }
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Telemetry export configuration is invalid.";
  }
  return { running: !!state.exporter, ...(state.error ? { error: state.error } : {}) };
}
