/**
 * PROD-OPS-02: the OpenTelemetry-compatible metrics registry, W3C tracer and OTLP exporter.
 * No collector, no network: the exporter is driven through an injected `post`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { METRIC_CATALOG, noteAdmission, opsMetrics, routeClassOf, statusClassOf } from "@/lib/ops/telemetry/catalog";
import { MetricsRegistry, TenantLabeler, metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { OtlpExporter, exporterConfigFromEnv, resourceAttributes, toOtlpMetrics, toOtlpTraces } from "@/lib/ops/telemetry/otlp";
import { Tracer, formatTraceparent, parseTraceparent, tracer } from "@/lib/ops/telemetry/tracing";

describe("MetricsRegistry", () => {
  it("renders Prometheus text for counters, gauges and histograms with escaped labels", () => {
    const r = new MetricsRegistry();
    r.counter("t_requests_total", "Requests.", ["tenant", "code"]).inc({ tenant: 'a"b', code: "200" }, 3);
    r.gauge("t_depth", "Depth.", ["tenant"]).set({ tenant: "x" }, 7);
    const h = r.histogram("t_latency_seconds", "Latency.", ["route"], [0.1, 1]);
    h.observe({ route: "/a" }, 0.0625);
    h.observe({ route: "/a" }, 0.5);
    h.observe({ route: "/a" }, 5);
    const text = r.renderPrometheus();
    expect(text).toContain("# TYPE t_requests_total counter");
    expect(text).toContain('t_requests_total{tenant="a\\"b",code="200"} 3');
    expect(text).toContain('t_depth{tenant="x"} 7');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="1"} 2');
    expect(text).toContain('t_latency_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(text).toContain('t_latency_seconds_count{route="/a"} 3');
    expect(text).toContain('t_latency_seconds_sum{route="/a"} 5.5625');
  });

  it("caps the series per metric: the next new label set folds into one overflow series and is counted", () => {
    const r = new MetricsRegistry(3);
    const c = r.counter("t_total", "x", ["id"]);
    for (let i = 0; i < 10; i++) c.inc({ id: `id${i}` });
    const text = r.renderPrometheus();
    expect(text).toContain('t_total{id="_overflow"} 7');
    expect(text.match(/^t_total\{/gm)).toHaveLength(4);
    expect(r.droppedCount("metric_series")).toBe(7);
    expect(text).toContain('zenith_telemetry_dropped_total{signal="metric_series"} 7');
  });

  it("never throws into a caller and ignores non-finite or negative samples", () => {
    const r = new MetricsRegistry();
    const c = r.counter("t_c_total", "x");
    expect(() => { c.inc({}, Number.NaN); c.inc({}, -1); r.histogram("t_h_seconds", "x").observe({}, Number.POSITIVE_INFINITY); r.gauge("t_g", "x").set({}, Number.NaN); }).not.toThrow();
    expect(r.renderPrometheus()).not.toMatch(/t_c_total \d/);
  });

  it("rejects an invalid metric name at definition time", () => {
    expect(() => new MetricsRegistry().counter("Bad-Name", "x")).toThrow();
  });

  it("replaces a gauge's whole series set for sampled snapshots", () => {
    const r = new MetricsRegistry();
    const g = r.gauge("t_depth", "x", ["tenant"]);
    g.replace([{ labels: { tenant: "a" }, value: 1 }, { labels: { tenant: "b" }, value: 2 }]);
    g.replace([{ labels: { tenant: "c" }, value: 3 }]);
    const text = r.renderPrometheus();
    expect(text).toContain('t_depth{tenant="c"} 3');
    expect(text).not.toContain('tenant="a"');
  });
});

describe("TenantLabeler", () => {
  it("admits a bounded number of distinct tenants and reports the rest as other", () => {
    const l = new TenantLabeler(2);
    expect([l.label("a"), l.label("b"), l.label("c"), l.label("a"), l.label(undefined)]).toEqual(["a", "b", "other", "a", "none"]);
    expect(l.label("bad id")).toBe("other");
  });
});

describe("catalog", () => {
  beforeEach(() => { metricsRegistry().reset(); });

  it("defines every cataloged metric with the cataloged labels", () => {
    opsMetrics();
    noteAdmission("api", "allowed", "ws_a");
    const text = metricsRegistry().renderPrometheus();
    for (const entry of METRIC_CATALOG.filter((m) => m.name !== "zenith_telemetry_dropped_total")) {
      expect(text, entry.name).toContain(`# TYPE ${entry.name} ${entry.type}`);
    }
    expect(new Set(METRIC_CATALOG.map((m) => m.name)).size).toBe(METRIC_CATALOG.length);
  });

  it("keeps route_class bounded: ids and tokens never become labels", () => {
    expect(routeClassOf("/api/platform/v1/operations/op_8f3a/approve")).toBe("/api/platform/v1/operations/:id/approve");
    expect(routeClassOf("/api/projects/ws_1234/deployments/dep-9")).toBe("/api/projects/:id/deployments/:id");
    expect(routeClassOf("/api/projects")).toBe("/api/projects");
    expect(routeClassOf("/api/platform/v1/operations")).toBe("/api/platform/v1/operations");
    expect(statusClassOf(429)).toBe("4xx");
    expect(statusClassOf(503)).toBe("5xx");
  });
});

describe("tracing", () => {
  const ratioOne = () => new Tracer({ sampleRatio: 1, maxBuffered: 4 });

  it("parses and formats W3C traceparent strictly", () => {
    const ok = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceparent(ok)).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
    expect(formatTraceparent(parseTraceparent(ok)!)).toBe(ok);
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled).toBe(false);
    for (const bad of ["", "garbage", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "00-00000000000000000000000000000000-00f067aa0ba902b7-01", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"])
      expect(parseTraceparent(bad), bad).toBeUndefined();
  });

  it("makes a child of an incoming context, a child of the active span, or a new root", async () => {
    const t = ratioOne();
    const root = t.startSpan("root", { parent: null });
    const viaHeader = t.startSpan("h", { parent: formatTraceparent(root.context) });
    expect(viaHeader.context.traceId).toBe(root.context.traceId);
    await t.run(root, async () => {
      const child = t.startSpan("child");
      expect(child.context.traceId).toBe(root.context.traceId);
      child.end();
      const forced = t.startSpan("forced-root", { parent: null });
      expect(forced.context.traceId).not.toBe(root.context.traceId);
    });
    viaHeader.end();
    const spans = t.drain();
    expect(spans.map((s) => s.name)).toEqual(["child", "root", "h"]);
    expect(spans[0].parentSpanId).toBe(root.context.spanId);
  });

  it("carries tenant and operation correlation attributes and bounds attribute count and size", () => {
    const t = ratioOne();
    const s = t.startSpan("op", { attributes: { "zenith.tenant.id": "ws_1", "zenith.operation.id": "op_1" } });
    for (let i = 0; i < 100; i++) s.setAttribute(`k${i}`, "v");
    s.setAttribute("long", "x".repeat(1000));
    s.setAttribute("bad key!", "x");
    s.end();
    const [done] = t.drain();
    expect(done.attributes["zenith.tenant.id"]).toBe("ws_1");
    expect(done.attributes["zenith.operation.id"]).toBe("op_1");
    expect(Object.keys(done.attributes).length).toBeLessThanOrEqual(32);
    expect(done.attributes["bad key!"]).toBeUndefined();
  });

  it("drops the OLDEST finished span when the ring is full, and counts it", () => {
    metricsRegistry().reset();
    const t = ratioOne();
    for (let i = 0; i < 7; i++) t.startSpan(`s${i}`, { parent: null }).end();
    expect(t.buffered).toBe(4);
    expect(t.drain().map((s) => s.name)).toEqual(["s3", "s4", "s5", "s6"]);
    expect(metricsRegistry().droppedCount("span")).toBe(3);
  });

  it("respects the parent's sampling decision, and head-samples roots by ratio", () => {
    const never = new Tracer({ sampleRatio: 0, maxBuffered: 10, random: () => 0.5 });
    never.startSpan("root", { parent: null }).end();
    expect(never.buffered).toBe(0);
    const parent = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")!;
    never.startSpan("sampled-by-parent", { parent }).end();
    expect(never.buffered).toBe(1);
  });

  it("records an error status when the wrapped function throws, and rethrows", async () => {
    const t = ratioOne();
    await expect(t.run(t.startSpan("boom"), async () => { throw new TypeError("x"); })).rejects.toThrow("x");
    expect(t.drain()[0]).toMatchObject({ name: "boom", status: "error", statusMessage: "TypeError" });
  });

  it("the shared tracer is a singleton", () => { expect(tracer()).toBe(tracer()); });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- OTLP JSON is inspected structurally in these two tests */
describe("OTLP serialization", () => {
  it("emits cumulative sums, gauges and explicit-bucket histograms with attribute names", () => {
    const r = new MetricsRegistry();
    r.counter("t_c_total", "c", ["tenant"]).inc({ tenant: "ws_1" }, 2);
    r.gauge("t_g", "g", []).set({}, 4);
    r.histogram("t_h_seconds", "h", ["route"], [0.1, 1]).observe({ route: "/a" }, 0.5);
    const body = toOtlpMetrics(r.snapshot(), resourceAttributes("zenith-control-plane", "i-1"), 1_000, 2_000) as {
      resourceMetrics: { resource: { attributes: { key: string }[] }; scopeMetrics: { metrics: Record<string, any>[] }[] }[];
    };
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const sum = metrics.find((m) => m.name === "t_c_total")!;
    expect(sum.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect(sum.sum.dataPoints[0]).toMatchObject({ asDouble: 2, attributes: [{ key: "tenant", value: { stringValue: "ws_1" } }], startTimeUnixNano: "1000000000", timeUnixNano: "2000000000" });
    expect(metrics.find((m) => m.name === "t_g")!.gauge.dataPoints[0].asDouble).toBe(4);
    const hist = metrics.find((m) => m.name === "t_h_seconds")!.histogram.dataPoints[0];
    expect(hist).toMatchObject({ count: "1", sum: 0.5, bucketCounts: ["0", "1", "0"], explicitBounds: [0.1, 1] });
    expect(body.resourceMetrics[0].resource.attributes.map((a) => a.key)).toEqual(["service.name", "service.instance.id"]);
  });

  it("emits spans with trace ids, parent ids and correlation attributes", () => {
    const t = new Tracer({ sampleRatio: 1, maxBuffered: 10 });
    const parent = t.startSpan("api", { parent: null, attributes: { "zenith.tenant.id": "ws_1", "zenith.operation.id": "op_1", "http.response.status_code": 200, ok: true } });
    const child = t.startSpan("dispatch", { parent: parent.context });
    child.setStatus("error", "queue_full");
    child.end();
    parent.end();
    const body = toOtlpTraces(t.drain(), resourceAttributes("svc", "i")) as { resourceSpans: { scopeSpans: { spans: Record<string, any>[] }[] }[] };
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    const dispatch = spans.find((s) => s.name === "dispatch")!;
    expect(dispatch).toMatchObject({ parentSpanId: parent.context.spanId, traceId: parent.context.traceId, status: { code: 2, message: "queue_full" } });
    const api = spans.find((s) => s.name === "api")!;
    expect(api.attributes).toEqual(expect.arrayContaining([
      { key: "zenith.tenant.id", value: { stringValue: "ws_1" } },
      { key: "zenith.operation.id", value: { stringValue: "op_1" } },
      { key: "http.response.status_code", value: { intValue: "200" } },
      { key: "ok", value: { boolValue: true } },
    ]));
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any */
describe("OTLP exporter", () => {
  it("is off without an endpoint and refuses unsafe endpoints with a fixed message", () => {
    expect(exporterConfigFromEnv({})).toBeUndefined();
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.com:4318" })).toThrow(/https/);
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })).toThrow(/absolute URL/);
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:pw@collector.example.com" })).toThrow(/credentials/);
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com?x=1" })).toThrow(/query/);
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com", ZENITH_OTEL_EXPORT_INTERVAL_MS: "5" })).toThrow(/INTERVAL/);
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com", ZENITH_OTEL_SERVICE_NAME: "bad name!" })).toThrow(/SERVICE_NAME/);
  });

  it("accepts https and a loopback http collector, and reads the bearer token from a file reference only", () => {
    expect(exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318/" })).toMatchObject({ endpoint: "http://127.0.0.1:4318", intervalMs: 15000, serviceName: "zenith-control-plane" });
    const config = exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com", ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE: "/run/secrets/otel" }, (file) => (file === "/run/secrets/otel" ? "tok-from-file" : ""));
    expect(config?.token).toBe("tok-from-file");
    expect(() => exporterConfigFromEnv({ ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example.com", ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE: "/definitely/not/here" })).toThrow(/TOKEN_FILE/);
  });

  it("pushes metrics and spans with the bearer, and a collector outage is a counted no-op, never an exception", async () => {
    metricsRegistry().reset();
    tracer().drain(10_000);
    opsMetrics().apiInflight.set({ scope: "global" }, 1);
    tracer().startSpan("export-me", { parent: { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true } }).end();
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ok = new OtlpExporter({ endpoint: "https://c.example.com", token: "t0k", intervalMs: 15000, serviceName: "svc" }, async (url, body, headers) => { sent.push({ url, headers, body }); return true; });
    const first = await ok.flush();
    expect(first).toEqual({ metrics: true, traces: true });
    expect(sent.map((s) => s.url)).toEqual(["https://c.example.com/v1/metrics", "https://c.example.com/v1/traces"]);
    expect(sent[0].headers.authorization).toBe("Bearer t0k");
    expect(sent[0].body).toContain("zenith_api_inflight_requests");

    const failing = new OtlpExporter({ endpoint: "https://c.example.com", intervalMs: 15000, serviceName: "svc" }, async () => { throw new Error("connection refused"); });
    await expect(failing.flush()).resolves.toEqual({ metrics: false, traces: true });
    expect(metricsRegistry().renderPrometheus()).toContain('zenith_telemetry_export_failures_total{signal="metrics"} 1');
  });

  it("keeps at most one export in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exporter = new OtlpExporter({ endpoint: "https://c.example.com", intervalMs: 15000, serviceName: "svc" }, async () => { await gate; return true; });
    const first = exporter.flush();
    await expect(exporter.flush()).resolves.toBeUndefined();
    release();
    await first;
  });
});
