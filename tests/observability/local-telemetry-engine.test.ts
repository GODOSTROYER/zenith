/**
 * Actual loopback TCP through the production factory, HTTP sources and fabric.
 * Endpoint replies and graph ownership are controlled protocol fixtures: this
 * is not a real Prometheus/Loki service or a broker-issued provider session.
 * Production provenance must remain contract evidence. No default API starts.
 */
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { sourcesForEnvironment } from "@/lib/observability/sources/factory";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { SignalScope } from "@/lib/observability/types";

const WORKSPACE = "telemetry-fixture-workspace";
const ENVIRONMENT = "telemetry-fixture-environment";
const node = (app: string): ResourceNode => ({
  address: `service/${app}`, kind: "container_service", provider: "kubernetes",
  region: "fixture-local", nativeType: "k8s:Deployment", ownership: "managed",
  spec: {}, origin: [], dependsOn: [], specDigest: "sha256:fixture",
  labels: { app, namespace: "telemetry-fixture" },
});
const graph = (apps = ["web"]): ResourceGraph => ({
  version: 1, environmentId: ENVIRONMENT, manifestDigest: "sha256:fixture",
  graphDigest: "sha256:fixture", nodes: apps.map(node), edges: [], notes: [],
});
const scope = (over: Partial<SignalScope> = {}): SignalScope => ({ workspaceId: WORKSPACE, environmentId: ENVIRONMENT, ...over });
type Mode = "fresh" | "empty" | "stale" | "delayed" | "partial";
interface RequestRecord {
  method: string; path: string; query: string | null; start: string | null;
  end: string | null; step: string | null; authorized: boolean; tenantMatched: boolean;
}

async function bounded<T>(pending: Promise<T>, failure: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(failure)), 5000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function endpoint() {
  const token = randomBytes(24).toString("hex");
  let acceptedToken = token;
  let mode: Mode = "fresh";
  const sampledAt = Date.now() - 1000;
  const requests: RequestRecord[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const failures: string[] = [];
  const listenController = new AbortController();
  const send = (res: ServerResponse, body: unknown, status = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const authorized = req.headers.authorization === `Bearer ${acceptedToken}`;
      const tenantMatched = req.headers["x-scope-orgid"] === WORKSPACE;
      const query = url.searchParams.get("query");
      requests.push({ method: req.method ?? "", path: url.pathname, query,
        start: url.searchParams.get("start"), end: url.searchParams.get("end"),
        step: url.searchParams.get("step"), authorized, tenantMatched });
      if (req.method !== "GET" || !authorized || !tenantMatched) {
        send(res, { error: "Access denied" }, 403); return;
      }
      if (mode === "partial" && query?.includes('app="api"')) {
        send(res, { error: "Access denied" }, 403); return;
      }
      const at = mode === "stale" ? sampledAt - 30 * 60_000 : sampledAt;
      const reply = () => {
        if (url.pathname === "/api/v1/query_range") {
          send(res, { status: "success", data: { resultType: "matrix", result: mode === "empty" ? [] : [{ metric: { app: "web" }, values: [[at / 1000, "2.5"]] }] } });
        } else if (url.pathname === "/loki/api/v1/query_range") {
          send(res, { status: "success", data: { resultType: "streams", result: mode === "empty" ? [] : [{ stream: { app: "web", level: "info" }, values: [[String(BigInt(at) * 1_000_000n), `password=${token} fixture telemetry`]] }] } });
        } else send(res, { error: "Unknown fixture endpoint" }, 404);
      };
      if (mode === "delayed") {
        const timer = setTimeout(() => {
          timers.delete(timer);
          try { reply(); } catch { failures.push("fixture_delayed_reply_failed"); res.destroy(); }
        }, 5000);
        timers.add(timer);
        res.once("close", () => { clearTimeout(timer); timers.delete(timer); });
      } else reply();
    } catch {
      failures.push("fixture_handler_failed");
      send(res, { error: "Fixture request failed" }, 500);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => { /* Destroyed owned sockets settle through close. */ });
  });
  server.on("error", () => failures.push("fixture_server_failed"));
  async function closeOwned() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const wasListening = server.listening;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (!error || (!wasListening && !server.listening && (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING")) resolve();
      else reject(new Error("Fixture endpoint close was unconfirmed"));
    }));
    const drained = [...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); }));
    const outcomes = await bounded(Promise.allSettled([closed, ...drained]), "Fixture endpoint shutdown did not settle");
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect({ listening: server.listening, sockets: sockets.size, timers: timers.size }).toEqual({ listening: false, sockets: 0, timers: 0 });
  }
  let address: AddressInfo;
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error("Fixture endpoint could not listen"));
      server.once("error", onError);
      server.listen({ port: 0, host: "127.0.0.1", signal: listenController.signal }, () => { server.removeListener("error", onError); resolve(); });
    }), "Fixture endpoint startup did not settle");
    const observed = server.address();
    if (!observed || typeof observed === "string" || observed.address !== "127.0.0.1") throw new Error("Fixture endpoint ownership was not established");
    address = observed;
  } catch {
    // Prevent a startup timeout from leaving a late listener behind.
    listenController.abort();
    await closeOwned();
    throw new Error("Fixture endpoint setup failed after owned cleanup");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const range = { from: new Date(sampledAt - 60 * 60_000).toISOString(), to: new Date(sampledAt + 1000).toISOString() };
  const sources = (apps = ["web"]) => sourcesForEnvironment({
    provider: "kubernetes", graph: graph(apps), workspaceId: WORKSPACE, sessions: {},
    endpoints: {
      prometheus: { baseUrl, tokenProvider: () => token, headers: { "X-Scope-OrgID": WORKSPACE }, requestTimeoutMs: 400, maxResponseBytes: 4096 },
      loki: { baseUrl, tokenProvider: () => token, headers: { "X-Scope-OrgID": WORKSPACE }, requestTimeoutMs: 400, maxResponseBytes: 4096 },
    },
  // Only the configured endpoint slice is under test; no provider session exists.
  }).filter((source) => source.id === "prometheus" || source.id === "loki");
  return {
    requests, range, sampledAt, sources,
    setMode: (value: Mode) => { mode = value; },
    revoke: () => { acceptedToken = randomBytes(24).toString("hex"); },
    containsToken: (value: unknown) => JSON.stringify(value).includes(token),
    async close() {
      await closeOwned();
      expect(failures.length).toBe(0);
    },
  };
}

async function usingEndpoint(run: (fixture: Awaited<ReturnType<typeof endpoint>>) => Promise<void>) {
  const fixture = await endpoint();
  try { await run(fixture); } finally { await fixture.close(); }
}

describe("local endpoint telemetry factory and fabric join", () => {
  it("binds real metric and log requests to the owned endpoint and reports scoped contract provenance without credentials", async () => {
    await usingEndpoint(async (fixture) => {
      const fabric = createObservabilityFabric(fixture.sources(), { timeoutMs: 2000 });
      const startedAt = Date.now();
      const metrics = await fabric.queryMetrics({ scope: scope({ addresses: ["service/web"] }), range: fixture.range, metrics: ["http.requests"], stepSec: 60 });
      const logs = await fabric.searchLogs({ scope: scope({ addresses: ["service/web"] }), range: fixture.range });
      // Guard any structural assertion from printing a credential-bearing body.
      expect(fixture.containsToken(metrics)).toBe(false);
      expect(fixture.containsToken(logs)).toBe(false);
      expect(metrics.items[0]).toMatchObject({ address: "service/web", metric: "http.requests", points: [{ timestamp: new Date(fixture.sampledAt).toISOString(), value: 2.5 }] });
      expect(logs.items).toHaveLength(1);
      expect(logs.items[0]).toMatchObject({ environmentId: ENVIRONMENT, address: "service/web", timestamp: new Date(fixture.sampledAt).toISOString() });
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests.every((request) => request.authorized && request.tenantMatched)).toBe(true);
      expect(fixture.requests.map((request) => [request.method, request.path, request.query])).toEqual([
        ["GET", "/api/v1/query_range", 'sum(rate(http_requests_total{app="web",namespace="telemetry-fixture"}[300s]))'],
        ["GET", "/loki/api/v1/query_range", '{app="web",namespace="telemetry-fixture"}'],
      ]);
      expect(fixture.requests[0]).toMatchObject({ start: String(Date.parse(fixture.range.from) / 1000), end: String(Date.parse(fixture.range.to) / 1000), step: "60" });
      expect(fixture.requests[1]).toMatchObject({ start: String(BigInt(Date.parse(fixture.range.from)) * 1_000_000n), end: String(BigInt(Date.parse(fixture.range.to)) * 1_000_000n) });
      for (const result of [metrics, logs]) {
        expect(result.telemetry).toMatchObject({ state: "fresh", partial: false, scope: scope({ addresses: ["service/web"] }) });
        expect(result.telemetry?.session).toBeUndefined();
        expect(result.telemetry?.provenance).toHaveLength(1);
        expect(result.telemetry?.provenance[0]).toMatchObject({ state: "fresh", itemCount: 1, simulated: false, evidence: { level: "contract" } });
        expect(Date.parse(result.telemetry!.observedAt) >= startedAt && Date.parse(result.telemetry!.observedAt) <= Date.now()).toBe(true);
        expect(fixture.containsToken(result)).toBe(false);
      }
    });
  });

  it("refuses foreign workspace, environment and unselected addresses before any endpoint request", async () => {
    await usingEndpoint(async (fixture) => {
      const sources = fixture.sources();
      const fabric = createObservabilityFabric(sources);
      for (const foreign of [scope({ workspaceId: "foreign" }), scope({ environmentId: "foreign" }), scope({ addresses: ["service/foreign"] })]) {
        const metrics = await fabric.queryMetrics({ scope: foreign, range: fixture.range, metrics: ["http.requests"] });
        const logs = await fabric.searchLogs({ scope: foreign, range: fixture.range });
        expect(metrics.items).toEqual([]); expect(logs.items).toEqual([]);
        expect(metrics.telemetry?.state).toBe("unknown"); expect(logs.telemetry?.state).toBe("unknown");
      }
      const direct = await sources.find((source) => source.id === "prometheus")!.queryMetrics!({ scope: scope({ workspaceId: "foreign" }), range: fixture.range, metrics: ["http.requests"] }, new AbortController().signal);
      expect(direct.items).toEqual([]);
      expect(direct.unavailable).toEqual([{ source: "prometheus", reason: "Scope is unavailable." }]);
      expect(fixture.requests).toEqual([]);
    });
  });

  it("rechecks current endpoint bearer authority and reports actual revocation as inaccessible", async () => {
    await usingEndpoint(async (fixture) => {
      const fabric = createObservabilityFabric(fixture.sources());
      const query = { scope: scope(), range: fixture.range, metrics: ["http.requests"] };
      const beforeRevocation = await fabric.queryMetrics(query);
      expect(fixture.containsToken(beforeRevocation)).toBe(false);
      expect(beforeRevocation.telemetry?.state).toBe("fresh");
      fixture.revoke();
      const refused = await fabric.queryMetrics(query);
      expect(fixture.containsToken(refused)).toBe(false);
      expect(refused.items).toEqual([]);
      expect(refused.telemetry).toMatchObject({ state: "inaccessible", provenance: [{ source: "prometheus", state: "inaccessible", itemCount: 0, evidence: { level: "contract" } }] });
      expect(fixture.requests.map((request) => request.authorized)).toEqual([true, false]);
      expect(fixture.containsToken(refused)).toBe(false);
    });
  });

  it("aborts a real delayed socket read and reports unknown rather than fresh or empty", async () => {
    await usingEndpoint(async (fixture) => {
      fixture.setMode("delayed");
      const fabric = createObservabilityFabric(fixture.sources(), { timeoutMs: 2000 });
      const result = await fabric.queryMetrics({ scope: scope(), range: fixture.range, metrics: ["http.requests"] });
      expect(fixture.containsToken(result)).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.telemetry).toMatchObject({ state: "unknown", provenance: [{ source: "prometheus", state: "unknown", itemCount: 0 }] });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0].authorized && fixture.requests[0].tenantMatched).toBe(true);
      expect(fixture.containsToken(result)).toBe(false);
    });
  });

  it("keeps reachable empty and old successful endpoint answers distinct", async () => {
    await usingEndpoint(async (fixture) => {
      const fabric = createObservabilityFabric(fixture.sources());
      for (const mode of ["empty", "stale"] as const) {
        fixture.setMode(mode);
        const metrics = await fabric.queryMetrics({ scope: scope(), range: fixture.range, metrics: ["http.requests"] });
        const logs = await fabric.searchLogs({ scope: scope(), range: fixture.range });
        for (const result of [metrics, logs]) {
          expect(fixture.containsToken(result)).toBe(false);
          expect(result.telemetry?.state).toBe(mode);
          expect(result.telemetry?.provenance[0]).toMatchObject({ state: mode, itemCount: mode === "empty" ? 0 : 1, evidence: { level: "contract" } });
          expect(result.unavailable).toEqual([]);
          expect(fixture.containsToken(result)).toBe(false);
        }
      }
      expect(fixture.requests).toHaveLength(4);
      expect(fixture.requests.every((request) => request.authorized && request.tenantMatched)).toBe(true);
    });
  });

  it("keeps a real successful scoped subread while marking a refused subread partial and inaccessible", async () => {
    await usingEndpoint(async (fixture) => {
      fixture.setMode("partial");
      const fabric = createObservabilityFabric(fixture.sources(["web", "api"]));
      const result = await fabric.searchLogs({ scope: scope(), range: fixture.range });
      expect(fixture.containsToken(result)).toBe(false);
      expect(result.items.map((item) => item.address)).toEqual(["service/web"]);
      expect(result.telemetry).toMatchObject({ state: "fresh", partial: true });
      expect(result.telemetry?.provenance.map((item) => [item.source, item.state, item.itemCount])).toEqual([["loki", "fresh", 1], ["loki", "inaccessible", 0]]);
      expect(result.telemetry?.provenance.every((item) => item.evidence.level === "contract")).toBe(true);
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests.every((request) => request.authorized && request.tenantMatched)).toBe(true);
      expect(fixture.containsToken(result)).toBe(false);
    });
  });
});
