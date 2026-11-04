import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { PROMETHEUS_SOURCE_ID, createPrometheusSource, parseMatrix, type PrometheusConfig } from "@/lib/observability/sources/prometheus";
import type { MetricQuery } from "@/lib/observability/types";
import { CANARY, graph, node, scope } from "./_fixtures";
import { hang, json, startServer, type Handler, type TestServer } from "./_http";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const mq = (metrics: string[], over: Partial<MetricQuery> = {}): MetricQuery => ({ scope: scope(), range: range(), metrics, stepSec: 60, ...over });
const signal = () => new AbortController().signal;

const web = node("service/web", "container_service", "kubernetes", { labels: { app: "web", namespace: "prod" } });

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const matrix = (values: [number, string][], labels: Record<string, string> = {}) => ({ status: "success", data: { resultType: "matrix", result: [{ metric: labels, values }] } });
const okHandler: Handler = (_req, res) => json(res, matrix([[(NOW - 120_000) / 1000, "1.5"], [(NOW - 60_000) / 1000, "2.5"]]));

async function make(handler: Handler, over: Partial<PrometheusConfig> = {}, nodes = [web]) {
  server = await startServer(handler);
  return createPrometheusSource({ baseUrl: server.url, graph: graph(nodes), ...over });
}

/** Remove Go string literals so structural checks only see PromQL syntax. */
const outsideStrings = (query: string) => query.replace(/"(?:[^"\\]|\\.)*"/g, '""');

describe("query construction", () => {
  it("sends query_range with start/end/step and the matchers from node labels", async () => {
    const s = await make(okHandler);
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    const req = server!.requests[0];
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/query_range");
    expect(req.params.get("query")).toBe('sum(rate(http_requests_total{app="web",namespace="prod"}[300s]))');
    expect(req.params.get("start")).toBe(String((NOW - 3600_000) / 1000));
    expect(req.params.get("end")).toBe(String(NOW / 1000));
    expect(req.params.get("step")).toBe("60");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ metric: "http.requests", unit: "Requests/Second", address: "service/web", provider: "kubernetes" });
    expect(r.items[0].points).toEqual([
      { timestamp: new Date(NOW - 120_000).toISOString(), value: 1.5 },
      { timestamp: new Date(NOW - 60_000).toISOString(), value: 2.5 },
    ]);
    expect(r.sources).toEqual([PROMETHEUS_SOURCE_ID]);
    expect(r.simulated).toBe(false);
  });

  it("maps every default metric to a fixed template with the selector substituted", async () => {
    const s = await make(okHandler);
    await s.queryMetrics!(mq(["cpu.utilization", "memory.utilization", "http.5xx.count", "http.target_response_time"]), signal());
    const queries = server!.requests.map((r) => r.params.get("query")!);
    expect(queries).toHaveLength(4);
    for (const q of queries) {
      expect(q).toContain('app="web",namespace="prod"');
      expect(q).not.toContain("{{");
    }
    expect(queries.find((q) => q.includes("5.."))).toContain('code=~"5.."');
  });

  it("escapes hostile label values so they stay inside their string literal", async () => {
    const evil = node("service/evil", "container_service", "kubernetes", { labels: { app: 'x"} or vector(1) # ', namespace: "a\nb\\c`d|e}" } });
    const s = await make(okHandler, {}, [evil]);
    await s.queryMetrics!(mq(["http.requests"], { scope: scope({ addresses: ["service/evil"] }) }), signal());
    const q = server!.requests[0].params.get("query")!;
    expect(outsideStrings(q)).toBe('sum(rate(http_requests_total{app="",namespace=""}[300s]))');
    expect(q).toContain('app="x\\"} or vector(1) # "');
    expect(q).toContain('namespace="a\\nb\\\\c`d|e}"');
    expect(q).not.toContain("\n");
  });

  it("sanitizes label NAMES from a configured label map and refuses reserved ones", async () => {
    const n = node("service/w", "container_service", "kubernetes", { labels: { "app.kubernetes.io/name": "w", weird: "v", bad: "v" } });
    const s = await make(okHandler, { labelMap: { "app.kubernetes.io/name": "app.kubernetes.io/name", weird: "we ird", bad: "__name__" } }, [n]);
    await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(server!.requests[0].params.get("query")).toBe('sum(rate(http_requests_total{app_kubernetes_io_name="w",we_ird="v"}[300s]))');
  });

  it("derives a namespace matcher from spec.namespace only when it is a valid Kubernetes name", async () => {
    const good = node("service/g", "container_service", "kubernetes", { labels: { app: "g" }, spec: { namespace: "team-a" } });
    const bad = node("service/b", "container_service", "kubernetes", { labels: { app: "b" }, spec: { namespace: 'x"} or 1 #' } });
    const s = await make(okHandler, {}, [good, bad]);
    await s.queryMetrics!(mq(["http.requests"]), signal());
    const byApp = server!.requests.map((r) => r.params.get("query")!).sort();
    expect(byApp).toEqual(['sum(rate(http_requests_total{app="b"}[300s]))', 'sum(rate(http_requests_total{app="g",namespace="team-a"}[300s]))']);
  });

  it("uses a longer rate window when the step is coarse", async () => {
    const s = await make(okHandler);
    await s.queryMetrics!(mq(["http.requests"], { stepSec: 900 }), signal());
    expect(server!.requests[0].params.get("query")).toContain("[900s]");
  });

  it("lets operators override or add metric templates, still substituting only the matchers", async () => {
    const s = await make(okHandler, { metrics: { "queue.depth": { expr: "max(jobs_pending{{{matchers}}})", unit: "Count" } } });
    const r = await s.queryMetrics!(mq(["queue.depth"]), signal());
    expect(server!.requests[0].params.get("query")).toBe('max(jobs_pending{app="web",namespace="prod"})');
    expect(r.items[0].unit).toBe("Count");
  });

  it("keeps a base URL path prefix", async () => {
    server = await startServer(okHandler);
    const s = createPrometheusSource({ baseUrl: `${server.url}/prom/`, graph: graph([web]) });
    await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(server.requests[0].path).toBe("/prom/api/v1/query_range");
  });
});

describe("unavailable, never an error", () => {
  it("unknown metrics (including prototype names) are unavailable and cause no request", async () => {
    const s = await make(okHandler);
    const r = await s.queryMetrics!(mq(["nope.metric", "constructor", "toString"]), signal());
    expect(server!.requests).toHaveLength(0);
    expect(r.items).toEqual([]);
    expect(r.unavailable).toHaveLength(3);
    expect(r.unavailable.every((u) => u.source === PROMETHEUS_SOURCE_ID && /not mapped for Prometheus/.test(u.reason))).toBe(true);
  });

  it("a node with no usable labels is not queried (an empty selector would match everything)", async () => {
    const bare = node("service/bare", "container_service", "kubernetes");
    const s = await make(okHandler, {}, [bare]);
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(server!.requests).toHaveLength(0);
    expect(r.unavailable[0].reason).toMatch(/service\/bare has no labels usable/);
  });

  it("Prometheus errors surface as unavailable with the error type", async () => {
    const s = await make((_req, res) => json(res, { status: "error", errorType: "bad_data", error: "parse error: unexpected end of input" }, 400));
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/HTTP 400/);
    expect(r.unavailable[0].reason).toMatch(/bad_data/);
    expect(r.sources).toEqual([]);
  });

  it("a 200 with status=error is unavailable too", async () => {
    const s = await make((_req, res) => json(res, { status: "error", errorType: "timeout", error: "query timed out" }));
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.unavailable[0].reason).toBe('metric "http.requests" for service/web: timeout: query timed out');
  });

  it("non-JSON and unexpected shapes are unavailable", async () => {
    let body: string | object = "<html>gateway</html>";
    const s = await make((_req, res) => (typeof body === "string" ? (res.writeHead(200), res.end(body)) : json(res, body)));
    expect((await s.queryMetrics!(mq(["http.requests"]), signal())).unavailable[0].reason).toMatch(/not JSON/);
    body = { status: "success", data: { resultType: "vector", result: [] } };
    expect((await s.queryMetrics!(mq(["http.requests"]), signal())).unavailable[0].reason).toMatch(/expected a matrix/);
  });

  it("drops NaN and infinite samples rather than coercing them", async () => {
    const s = await make((_req, res) => json(res, matrix([[1, "NaN"], [2, "+Inf"], [3, "-Inf"], [4, "7"], [5, "not-a-number"]])));
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.items[0].points).toEqual([{ timestamp: new Date(4000).toISOString(), value: 7 }]);
  });

  it("refuses redirects instead of following them with a bearer token", async () => {
    const s = await make((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
      res.end();
    }, { tokenProvider: () => "tok" });
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable).toHaveLength(1);
  });

  it("caps response size", async () => {
    const s = await make((_req, res) => json(res, matrix(Array.from({ length: 2000 }, (_, i) => [i, "1"] as [number, string]))), { maxResponseBytes: 2048 });
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.unavailable[0].reason).toMatch(/larger than 2048 bytes/);
  });

  it("a slow request times out on its own: that series is unavailable, the others still answer", async () => {
    const s = await make((req, res) => (req.params.get("query")!.includes("5..") ? undefined : okHandler(req, res)), { requestTimeoutMs: 400 });
    const r = await s.queryMetrics!(mq(["http.requests", "http.5xx.count"]), signal());
    expect(r.items.map((i) => i.metric)).toEqual(["http.requests"]);
    expect(r.unavailable).toEqual([{ source: PROMETHEUS_SOURCE_ID, reason: 'metric "http.5xx.count" for service/web: request timed out after 400 ms' }]);
  });

  it("an unreachable server is unavailable", async () => {
    const s = createPrometheusSource({ baseUrl: "http://127.0.0.1:1", graph: graph([web]) });
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.unavailable[0].reason).toMatch(/request failed/);
  });
});

describe("bearer token", () => {
  it("is sent as a Bearer header from the injected provider, per request", async () => {
    let n = 0;
    const s = await make(okHandler, { tokenProvider: () => `token-${++n}` });
    await s.queryMetrics!(mq(["http.requests", "http.5xx.count"]), signal());
    const auth = server!.requests.map((r) => r.headers.authorization).sort();
    expect(auth).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("is omitted when the provider returns nothing", async () => {
    const s = await make(okHandler, { tokenProvider: async () => undefined });
    await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(server!.requests[0].headers.authorization).toBeUndefined();
  });

  it("a token that could split a header is refused and never echoed", async () => {
    const s = await make(okHandler, { tokenProvider: () => `abc\r\nX-Injected: 1 ${CANARY.bearer}` });
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(server!.requests).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(CANARY.bearer);
    expect(r.unavailable[0].reason).toMatch(/not a valid bearer token/);
  });

  it("is not leaked into error text when the backend echoes it", async () => {
    const s = await make((req, res) => json(res, { status: "error", error: `bad auth header ${req.headers.authorization}` }, 401), { tokenProvider: () => CANARY.bearer });
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(JSON.stringify(r)).not.toContain(CANARY.bearer);
  });
});

describe("configuration and cancellation", () => {
  it("rejects base URLs with credentials, other schemes or query strings", () => {
    const g = graph([web]);
    for (const baseUrl of ["http://user:pw@prom:9090", "ftp://prom", "file:///etc/passwd", "not a url", "http://prom:9090/?x=1"]) {
      expect(() => createPrometheusSource({ baseUrl, graph: g })).toThrow();
    }
  });

  it("refuses cloud metadata hosts but allows private and loopback addresses (in-cluster backends)", () => {
    const g = graph([web]);
    for (const baseUrl of ["http://169.254.169.254/latest", "http://169.254.170.2/v2", "http://metadata.google.internal/", "http://[fd00:ec2::254]/", "http://100.100.100.200/"]) {
      expect(() => createPrometheusSource({ baseUrl, graph: g })).toThrow(/metadata/);
    }
    for (const baseUrl of ["http://10.1.2.3:9090", "http://prometheus.monitoring.svc:9090", "http://127.0.0.1:9090", "https://prom.example.com/prefix"]) {
      expect(() => createPrometheusSource({ baseUrl, graph: g })).not.toThrow();
    }
  });

  it("covers only workload nodes in its environment", async () => {
    const s = await make(okHandler, {}, [web, node("resource/db", "postgres", "kubernetes")]);
    expect(s.covers!(scope())).toBe(true);
    expect(s.covers!(scope({ addresses: ["resource/db"] }))).toBe(false);
    expect(s.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
  });

  it("an abort cancels an in-flight request against a server that never answers", async () => {
    const s = await make(hang);
    const ctl = new AbortController();
    const pending = s.queryMetrics!(mq(["http.requests"]), ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("through the fabric a hung Prometheus is an unavailable entry after the timeout", async () => {
    const s = await make(hang);
    const fabric = createObservabilityFabric([s], { timeoutMs: 80, now: () => new Date(NOW) });
    const t0 = Date.now();
    const r = await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["http.requests"] });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.unavailable).toEqual([{ source: PROMETHEUS_SOURCE_ID, reason: "timed out after 80 ms" }]);
  });

  it("caps series per query", async () => {
    const many = Array.from({ length: 60 }, (_, i) => node(`service/s${i}`, "container_service", "kubernetes", { labels: { app: `s${i}` } }));
    const s = await make(okHandler, {}, many);
    const r = await s.queryMetrics!(mq(["http.requests"]), signal());
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect(server!.requests).toHaveLength(50);
  });
});

describe("parseMatrix", () => {
  it("keeps labels and skips malformed series", () => {
    const r = parseMatrix({ status: "success", data: { resultType: "matrix", result: [{ metric: { pod: "a", n: 1 }, values: [[1, "2"]] }, { nope: true }, { metric: {}, values: "bad" }] } });
    expect(r).toEqual({ ok: true, series: [{ labels: { pod: "a" }, points: [{ timestamp: "1970-01-01T00:00:01.000Z", value: 2 }] }] });
  });
});
