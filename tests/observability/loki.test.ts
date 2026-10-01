import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { LOKI_SOURCE_ID, buildLogQL, createLokiSource, nsToIso, type LokiConfig } from "@/lib/observability/sources/loki";
import type { LogQuery } from "@/lib/observability/types";
import { CANARY, ENV, graph, node, parseGoString, scope } from "./_fixtures";
import { hang, json, startServer, type Handler, type TestServer } from "./_http";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const lq = (over: Partial<LogQuery> = {}): LogQuery => ({ scope: scope(), range: range(), limit: 100, ...over });
const signal = () => new AbortController().signal;
const ns = (msAgo: number) => String((BigInt(NOW - msAgo) * 1_000_000n) + 123n);

const web = node("service/web", "container_service", "kubernetes", { labels: { app: "web", namespace: "prod" } });

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const streams = (result: unknown[]) => ({ status: "success", data: { resultType: "streams", result } });
const stream = (labels: Record<string, string>, values: [string, string][]) => ({ stream: labels, values });

async function make(handler: Handler, over: Partial<LokiConfig> = {}, nodes = [web]) {
  server = await startServer(handler);
  return createLokiSource({ baseUrl: server.url, graph: graph(nodes), ...over });
}

const ATTACKS = ['plain', 'quo"te', "back\\slash", 'x" | json | drop', "`tick` ${x}", "a}{b", "line1\nline2", '} or {job=~".+"} |= "', "tab\there", "unicode ✓"];

describe("LogQL construction", () => {
  it("is `{selector}` when there is no text and `{selector} |= \"literal\"` when there is", async () => {
    const s = await make((_req, res) => json(res, streams([])));
    await s.searchLogs!(lq(), signal());
    await s.searchLogs!(lq({ text: "timeout" }), signal());
    const queries = server!.requests.map((r) => r.params.get("query"));
    expect(queries).toEqual(['{app="web",namespace="prod"}', '{app="web",namespace="prod"} |= "timeout"']);
  });

  it.each(ATTACKS)("keeps hostile text %j inside one escaped literal", async (attack) => {
    const s = await make((_req, res) => json(res, streams([])));
    await s.searchLogs!(lq({ text: attack }), signal());
    const query = server!.requests[0].params.get("query")!;
    const prefix = '{app="web",namespace="prod"} |= ';
    expect(query.startsWith(prefix)).toBe(true);
    const parsed = parseGoString(query.slice(prefix.length));
    expect(parsed.rest).toBe("");
    expect(parsed.value).toBe(attack);
    expect(query).not.toContain("\n");
  });

  it("escapes hostile label values from the graph", () => {
    expect(buildLogQL({ app: 'x"} |= "', namespace: "n\\s" }, undefined)).toBe('{app="x\\"} |= \\"",namespace="n\\\\s"}');
    expect(buildLogQL({}, "text")).toBeUndefined();
    expect(buildLogQL({ __name__: "x" }, "text")).toBeUndefined();
  });

  it("sends nanosecond start/end, the limit, and direction=backward on the query_range endpoint", async () => {
    const s = await make((_req, res) => json(res, streams([])));
    await s.searchLogs!(lq({ limit: 42 }), signal());
    const req = server!.requests[0];
    expect(req.path).toBe("/loki/api/v1/query_range");
    expect(req.params.get("start")).toBe(String(BigInt(NOW - 3600_000) * 1_000_000n));
    expect(req.params.get("end")).toBe(String(BigInt(NOW) * 1_000_000n));
    expect(req.params.get("limit")).toBe("42");
    expect(req.params.get("direction")).toBe("backward");
  });

  it("queries each node in scope separately and labels results with its address", async () => {
    const api = node("service/api", "container_service", "kubernetes", { labels: { app: "api" } });
    const s = await make((req, res) => {
      const app = req.params.get("query")!.includes('app="api"') ? "api" : "web";
      json(res, streams([stream({ app }, [[ns(1000), `line from ${app}`]])]));
    }, {}, [web, api]);
    const r = await s.searchLogs!(lq(), signal());
    expect(server!.requests).toHaveLength(2);
    expect(r.items.map((l) => [l.address, l.message]).sort()).toEqual([["service/api", "line from api"], ["service/web", "line from web"]]);
    const onlyApi = await s.searchLogs!(lq({ scope: scope({ addresses: ["service/api"] }) }), signal());
    expect(onlyApi.items.map((l) => l.address)).toEqual(["service/api"]);
  });

  it("does not query nodes without usable labels and says so", async () => {
    const bare = node("service/bare", "container_service", "kubernetes");
    const s = await make((_req, res) => json(res, streams([])), {}, [bare]);
    const r = await s.searchLogs!(lq(), signal());
    expect(server!.requests).toHaveLength(0);
    expect(r.unavailable[0].reason).toMatch(/service\/bare: no labels usable as a Loki stream selector/);
    expect(r.sources).toEqual([]);
  });
});

describe("mapping", () => {
  it("normalizes streams to logs, newest first, with labels and nanosecond timestamps in native", async () => {
    const s = await make((_req, res) =>
      json(
        res,
        streams([
          stream({ app: "web", pod: "web-1", level: "error" }, [[ns(10_000), "old error"], [ns(2000), "newer error"]]),
          stream({ app: "web", pod: "web-2" }, [[ns(5000), "level=warn middle"], [ns(1000), '{"level":"info","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","msg":"hi"}']]),
        ])
      )
    );
    const r = await s.searchLogs!(lq(), signal());
    expect(r.items.map((l) => l.message)).toEqual(['{"level":"info","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","msg":"hi"}', "newer error", "level=warn middle", "old error"]);
    const [json1, err, warn] = r.items;
    expect(json1).toMatchObject({ severity: "info", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", address: "service/web", provider: "kubernetes", environmentId: ENV });
    expect(json1.native).toMatchObject({ backend: "loki", labels: { app: "web", pod: "web-2" }, severityHeuristic: "json_level" });
    expect(err.severity).toBe("error");
    expect(err.native.severityHeuristic).toBe("detected_level");
    expect(warn.severity).toBe("warn");
    expect(warn.native.severityHeuristic).toBe("level_kv");
    expect(err.timestamp).toBe(new Date(NOW - 2000).toISOString());
    expect(String(err.native.timestampNs)).toBe(ns(2000));
    expect(r.sources).toEqual([LOKI_SOURCE_ID]);
    expect(r.simulated).toBe(false);
  });

  it("prefers Loki's detected_level over message heuristics and records that it did", async () => {
    const s = await make((_req, res) => json(res, streams([stream({ app: "web", detected_level: "warn" }, [[ns(1000), "ERROR looks bad but stream says warn"]])])));
    const r = await s.searchLogs!(lq(), signal());
    expect(r.items[0].severity).toBe("warn");
    expect(r.items[0].native.severityHeuristic).toBe("detected_level");
  });

  it("filters by minSeverity and notes the exclusion of unknown-severity lines", async () => {
    const s = await make((_req, res) => json(res, streams([stream({ app: "web" }, [[ns(1000), "ERROR bad"], [ns(2000), "INFO fine"], [ns(3000), "no level"]])])));
    const r = await s.searchLogs!(lq({ minSeverity: "error" }), signal());
    expect(r.items.map((l) => l.message)).toEqual(["ERROR bad"]);
    expect(r.notes?.join()).toMatch(/severity could not be determined/);
  });

  it("redacts secrets in lines and labels", async () => {
    const s = await make((_req, res) =>
      json(res, streams([stream({ app: "web", note: `key ${CANARY.awsKeyId}` }, [[ns(1000), `db postgres://a:${CANARY.dbUrlPassword}@h/x password=${CANARY.password} ${CANARY.jwt}`]])]))
    );
    const r = await s.searchLogs!(lq(), signal());
    const text = JSON.stringify(r);
    for (const secret of [CANARY.dbUrlPassword, CANARY.password, CANARY.awsKeyId, CANARY.jwt]) expect(text).not.toContain(secret);
    expect(r.items[0].attributes.redacted).toBe(true);
  });

  it("flags truncation when a query returns a full page", async () => {
    const s = await make((_req, res) => json(res, streams([stream({ app: "web" }, Array.from({ length: 5 }, (_, i) => [ns(1000 + i), `m${i}`] as [string, string]))])));
    expect((await s.searchLogs!(lq({ limit: 5 }), signal())).truncated).toBe(true);
    expect((await s.searchLogs!(lq({ limit: 50 }), signal())).truncated).toBe(false);
  });

  it("skips malformed entries and converts timestamps exactly", () => {
    expect(nsToIso("1759233600123456789")).toBe("2025-09-30T12:00:00.123Z");
    expect(nsToIso("not-a-number")).toBeUndefined();
    expect(nsToIso("")).toBeUndefined();
  });

  it("ignores malformed values without failing the query", async () => {
    const s = await make((_req, res) => json(res, streams([stream({ app: "web" }, [[ns(1000), "good"], ["bad-ts", "x"], [ns(2000)] as unknown as [string, string]])])));
    const r = await s.searchLogs!(lq(), signal());
    expect(r.items.map((l) => l.message)).toEqual(["good"]);
  });
});

describe("failures, headers and cancellation", () => {
  it("HTTP errors are unavailable with a redacted, bounded reason", async () => {
    const s = await make((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`rpc error: password=${CANARY.password} ${"x".repeat(5000)}`);
    });
    const r = await s.searchLogs!(lq(), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/HTTP 500/);
    expect(r.unavailable[0].reason).not.toContain(CANARY.password);
    expect(Buffer.byteLength(r.unavailable[0].reason, "utf8")).toBeLessThanOrEqual(512);
  });

  it("status=error and wrong result types are unavailable", async () => {
    let body: unknown = { status: "error", error: "max entries limit exceeded" };
    const s = await make((_req, res) => json(res, body));
    expect((await s.searchLogs!(lq(), signal())).unavailable[0].reason).toMatch(/max entries limit exceeded/);
    body = { status: "success", data: { resultType: "matrix", result: [] } };
    expect((await s.searchLogs!(lq(), signal())).unavailable[0].reason).toMatch(/expected streams/);
  });

  it("one node failing leaves the others' logs intact", async () => {
    const api = node("service/api", "container_service", "kubernetes", { labels: { app: "api" } });
    const s = await make((req, res) => (req.params.get("query")!.includes('"api"') ? json(res, { status: "error", error: "boom" }, 500) : json(res, streams([stream({ app: "web" }, [[ns(1000), "web ok"]])]))), {}, [web, api]);
    const r = await s.searchLogs!(lq(), signal());
    expect(r.items.map((l) => l.message)).toEqual(["web ok"]);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0].reason).toMatch(/^service\/api: /);
    expect(r.sources).toEqual([LOKI_SOURCE_ID]);
  });

  it("a slow request times out on its own: that node is unavailable, the others still answer", async () => {
    const api = node("service/api", "container_service", "kubernetes", { labels: { app: "api" } });
    const s = await make(
      (req, res) => (req.params.get("query")!.includes('"api"') ? undefined : json(res, streams([stream({ app: "web" }, [[ns(1000), "web ok"]])]))),
      { requestTimeoutMs: 400 },
      [web, api]
    );
    const t0 = Date.now();
    const r = await s.searchLogs!(lq(), signal());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.items.map((l) => l.message)).toEqual(["web ok"]);
    expect(r.unavailable).toEqual([{ source: LOKI_SOURCE_ID, reason: "service/api: request timed out after 400 ms" }]);
  });

  it("sends the bearer token and X-Scope-OrgID, and nothing else sensitive", async () => {
    const s = await make((_req, res) => json(res, streams([])), { tokenProvider: () => "loki-token", headers: { "X-Scope-OrgID": "tenant-a", "bad header": "x", "X-Evil": "a\r\nb" } });
    await s.searchLogs!(lq(), signal());
    const h = server!.requests[0].headers;
    expect(h.authorization).toBe("Bearer loki-token");
    expect(h["x-scope-orgid"]).toBe("tenant-a");
    expect(h["x-evil"]).toBeUndefined();
  });

  it("an abort cancels an in-flight request", async () => {
    const s = await make(hang);
    const ctl = new AbortController();
    const pending = s.searchLogs!(lq(), ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("through the fabric a hung Loki is an unavailable entry after the timeout", async () => {
    const s = await make(hang);
    const fabric = createObservabilityFabric([s], { timeoutMs: 80, now: () => new Date(NOW) });
    const r = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(r.unavailable).toEqual([{ source: LOKI_SOURCE_ID, reason: "timed out after 80 ms" }]);
  });

  it("through the fabric, hostile text still arrives as one escaped literal", async () => {
    const s = await make((_req, res) => json(res, streams([])));
    const fabric = createObservabilityFabric([s], { now: () => new Date(NOW) });
    const text = '") |= "" or {a="b';
    await fabric.searchLogs({ scope: scope(), range: range(), text });
    const query = server!.requests[0].params.get("query")!;
    const prefix = '{app="web",namespace="prod"} |= ';
    expect(parseGoString(query.slice(prefix.length))).toEqual({ value: text, rest: "" });
  });

  it("covers only Loki-labelled workload kinds in its environment", async () => {
    const s = await make((_req, res) => json(res, streams([])), {}, [web, node("resource/db", "postgres", "kubernetes")]);
    expect(s.covers!(scope())).toBe(true);
    expect(s.covers!(scope({ addresses: ["resource/db"] }))).toBe(false);
    expect(s.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
  });
});
