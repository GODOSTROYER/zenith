import { describe, expect, it, vi } from "vitest";
import type { AppLogLine, HealthEvent, ServiceHealth } from "@/lib/logsim";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { SANDBOX_SOURCE_ID, createSandboxSource, toRuntimeState, type SandboxDeps } from "@/lib/observability/sources/sandbox";
import type { EventQuery, LogQuery } from "@/lib/observability/types";
import { CANARY, ENV, graph, node, scope } from "./_fixtures";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const now = () => new Date(NOW);
const iso = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const lq = (over: Partial<LogQuery> = {}): LogQuery => ({ scope: scope(), range: range(), limit: 100, ...over });
const eq = (over: Partial<EventQuery> = {}): EventQuery => ({ scope: scope(), range: range(), limit: 100, ...over });
const signal = () => new AbortController().signal;

const api = node("service/api", "container_service", "sandbox", { origin: ["svc-api"] });
const worker = node("service/worker", "container_service", "sandbox", { origin: ["svc-worker"] });
const site = node("service/site", "static_site", "sandbox", { origin: ["svc-site"] });
const noOrigin = node("service/orphan", "container_service", "sandbox");
const aws = node("service/aws", "container_service", "aws");

const okHealth: ServiceHealth = { status: "ok", replicasReady: 2, replicasDesired: 2, latencyMs: 12, reason: "All 2 replica(s) passing health checks since the last successful deployment.", history: [] };

function line(secAgo: number, text: string, stream: "stdout" | "stderr" = "stdout", seq = 0): AppLogLine {
  return { seq, ts: iso(secAgo), line: `${iso(secAgo)} ${text}`, stream };
}

function deps(over: Partial<SandboxDeps> = {}): SandboxDeps {
  return { getServiceLogs: () => [], health: () => okHealth, ...over };
}

const make = (nodes = [api], d: SandboxDeps = deps()) => createSandboxSource({ graph: graph(nodes), deps: d, now });

describe("sandbox logs", () => {
  it("wraps logsim lines as simulated NormalizedLogs, newest first", async () => {
    const getServiceLogs = vi.fn((_env: string, serviceId: string) => (serviceId === "svc-api" ? [line(30, "INFO  req=1 GET / 200 5ms", "stdout", 1), line(10, "ERROR req=2 GET /api 500 40ms", "stderr", 2)] : []));
    const r = await make([api], deps({ getServiceLogs })).searchLogs!(lq(), signal());
    expect(getServiceLogs).toHaveBeenCalledWith(ENV, "svc-api");
    expect(r.items.map((l) => l.severity)).toEqual(["error", "info"]);
    expect(r.items[0]).toMatchObject({ address: "service/api", provider: "sandbox", environmentId: ENV, timestamp: iso(10) });
    expect(r.items[0].native).toMatchObject({ simulated: true, seq: 2, stream: "stderr", serviceId: "svc-api", severityHeuristic: "keyword" });
    expect(r.items[0].attributes).toMatchObject({ stream: "stderr", simulated: true });
    expect(r.simulated).toBe(true);
    expect(r.sources).toEqual([SANDBOX_SOURCE_ID]);
    expect(r.notes?.join()).toMatch(/simulated/);
  });

  it("simulated propagates through the fabric, also when merged with a real source", async () => {
    const real = { id: "real", provider: "aws", supports: ["log" as const], searchLogs: async () => ({ items: [], sources: ["real"], truncated: false, simulated: false, unavailable: [] }) };
    const source = make([api], deps({ getServiceLogs: () => [line(5, "INFO ok")] }));
    const fabric = createObservabilityFabric([real, source], { now });
    const r = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(r.simulated).toBe(true);
    expect(r.items).toHaveLength(1);
  });

  it("treats a stderr line with no recognizable level as an error", async () => {
    const r = await make([api], deps({ getServiceLogs: () => [line(5, "something odd", "stderr")] })).searchLogs!(lq(), signal());
    expect(r.items[0].severity).toBe("error");
  });

  it("filters by range, text (case-sensitive substring) and minSeverity", async () => {
    const lines = [line(4000, "ERROR too old"), line(60, "ERROR timeout talking to db"), line(50, "INFO all good"), line(40, "WARN slow"), line(30, "ERROR Timeout")];
    const source = make([api], deps({ getServiceLogs: () => lines }));
    const inRange = await source.searchLogs!(lq({ range: range(30) }), signal());
    expect(inRange.items).toHaveLength(4);
    expect((await source.searchLogs!(lq({ text: "timeout" }), signal())).items.map((l) => l.message.slice(25))).toEqual(["ERROR timeout talking to db"]);
    const warn = await source.searchLogs!(lq({ minSeverity: "warn", range: range(30) }), signal());
    expect(warn.items.map((l) => l.severity).sort()).toEqual(["error", "error", "warn"]);
  });

  it("honours the limit and reports truncation", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i + 1, `INFO n${i}`));
    const r = await make([api], deps({ getServiceLogs: () => lines })).searchLogs!(lq({ limit: 10 }), signal());
    expect(r.items).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("redacts secrets even in simulated lines", async () => {
    const r = await make([api], deps({ getServiceLogs: () => [line(1, `INFO password=${CANARY.password}`)] })).searchLogs!(lq(), signal());
    expect(JSON.stringify(r)).not.toContain(CANARY.password);
  });

  it("serves only sandbox nodes with a service id, and only in its own environment", async () => {
    const getServiceLogs = vi.fn(() => [line(1, "INFO x")]);
    const source = make([api, aws, noOrigin], deps({ getServiceLogs }));
    await source.searchLogs!(lq(), signal());
    expect(getServiceLogs).toHaveBeenCalledTimes(1);
    expect(source.covers!(scope({ addresses: ["service/aws"] }))).toBe(false);
    expect(source.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
    getServiceLogs.mockClear();
    const r = await source.searchLogs!(lq({ scope: { workspaceId: "ws-1", environmentId: "other" } }), signal());
    expect(r.items).toEqual([]);
    expect(getServiceLogs).not.toHaveBeenCalled();
  });

  it("supports a custom node → service id mapping", async () => {
    const getServiceLogs = vi.fn(() => []);
    const labelled = node("service/api", "container_service", "sandbox", { labels: { sid: "svc-from-label" } });
    const source = createSandboxSource({ graph: graph([labelled]), deps: deps({ getServiceLogs }), serviceIdFor: (n) => n.labels.sid, now });
    await source.searchLogs!(lq(), signal());
    expect(getServiceLogs).toHaveBeenCalledWith(ENV, "svc-from-label");
  });
});

describe("sandbox events (health history)", () => {
  const history: HealthEvent[] = [
    { at: iso(3000), status: "ok", reason: "r1 started 2 healthy replica(s).", revisionNumber: 1 },
    { at: iso(900), status: "degraded", reason: "r3 started api with a replica that fails its health probe.", revisionNumber: 3 },
    { at: iso(60), status: "absent", reason: "Not part of r4 — nothing was running.", revisionNumber: 4 },
  ];

  it("maps health transitions to simulated events", async () => {
    const r = await make([api], deps({ healthHistory: () => history })).searchEvents!(eq(), signal());
    expect(r.items.map((e) => [e.type, e.severity])).toEqual([
      ["sandbox.health.absent", "info"],
      ["sandbox.health.degraded", "warn"],
      ["sandbox.health.ok", "info"],
    ]);
    expect(r.items[1]).toMatchObject({ address: "service/api", provider: "sandbox", message: expect.stringContaining("r3 started api") });
    expect(r.items[1].native).toMatchObject({ simulated: true, revisionNumber: 3, serviceId: "svc-api" });
    expect(r.simulated).toBe(true);
  });

  it("filters by range and works without a healthHistory dependency", async () => {
    const r = await make([api], deps({ healthHistory: () => history })).searchEvents!(eq({ range: range(30) }), signal());
    expect(r.items).toHaveLength(2);
    expect((await make([api], deps()).searchEvents!(eq(), signal())).items).toEqual([]);
  });
});

describe("sandbox health", () => {
  it("maps ServiceHealth to RuntimeState, always simulated", async () => {
    const source = make([api, worker], deps({
      health: (_env, id) => (id === "svc-api" ? okHealth : { ...okHealth, status: "degraded", replicasReady: 1, reason: "1 of 2 replica(s) are failing their health probe." }),
    }));
    const states = await source.health(scope());
    expect(states).toEqual([
      { address: "service/api", health: "healthy", counts: { desired: 2, ready: 2, unhealthy: 0 }, signals: [], observedAt: new Date(NOW).toISOString(), source: SANDBOX_SOURCE_ID, simulated: true },
      { address: "service/worker", health: "degraded", counts: { desired: 2, ready: 1, unhealthy: 1 }, signals: ["replicas_not_ready:1"], observedAt: new Date(NOW).toISOString(), source: SANDBOX_SOURCE_ID, simulated: true },
    ]);
  });

  it("toRuntimeState: nothing deployed is unknown, no ready replicas is unhealthy, status alone can degrade", () => {
    const at = "2026-09-30T12:00:00.000Z";
    expect(toRuntimeState("a", { ...okHealth, replicasDesired: 0, replicasReady: 0, status: "degraded", reason: "Nothing has been deployed to this environment yet." }, at)).toMatchObject({ health: "unknown", signals: ["nothing_deployed"], counts: {} });
    expect(toRuntimeState("a", { ...okHealth, status: "degraded", replicasReady: 0 }, at)).toMatchObject({ health: "unhealthy", signals: ["replicas_not_ready:2"] });
    expect(toRuntimeState("a", { ...okHealth, status: "degraded", replicasReady: 2 }, at)).toMatchObject({ health: "degraded", signals: ["status_degraded"] });
  });

  it("static sites are served too (logsim returns nothing for them)", async () => {
    const states = await make([site]).health(scope());
    expect(states).toHaveLength(1);
  });
});
