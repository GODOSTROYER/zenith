/**
 * PROD-OBS-02 composition: the DEFAULT observability stack (no caller-supplied
 * endpoints) takes Prometheus/Loki from the validated platform environment
 * (ZENITH_OBSERVE_*), so the real MCP / incident / verify callers produce
 * scoped telemetry envelopes that name those backends.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { sourcesForEnvironment } from "@/lib/observability/sources/factory";
import { configuredEndpoints } from "@/lib/observability/sources/configured-endpoints";
import { fakeAwsSession, graph, node, scope } from "./_fixtures";
import { json, startServer, type TestServer } from "./_http";

const KEYS = ["ZENITH_OBSERVE_PROMETHEUS_URL", "ZENITH_OBSERVE_PROMETHEUS_TOKEN", "ZENITH_OBSERVE_LOKI_URL", "ZENITH_OBSERVE_LOKI_TOKEN", "ZENITH_OBSERVE_LOKI_TENANT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const ids = (sources: { id: string }[]) => sources.map((s) => s.id).sort();
const awsGraph = graph([node("service/web", "container_service", "aws", { spec: { logGroup: "/ecs/prod/web" }, labels: { app: "web" } })]);
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const range = { from: new Date(NOW - 3_600_000).toISOString(), to: new Date(NOW).toISOString() };

describe("default telemetry endpoint configuration", () => {
  it("adds nothing when no endpoint is configured", () => {
    for (const k of KEYS) delete process.env[k];
    expect(ids(sourcesForEnvironment({ provider: "sandbox", graph: graph([]), sessions: {} }))).toEqual(["sandbox.logsim"]);
    expect(configuredEndpoints().endpoints).toEqual({});
  });

  it("the default factory adds Prometheus and Loki from the platform environment for any provider", async () => {
    const server: TestServer = await startServer((_r, res) => json(res, {}));
    try {
      process.env.ZENITH_OBSERVE_PROMETHEUS_URL = server.url;
      process.env.ZENITH_OBSERVE_LOKI_URL = server.url;
      const sources = sourcesForEnvironment({ provider: "aws", graph: awsGraph, sessions: { aws: fakeAwsSession() } });
      expect(ids(sources)).toEqual(["aws.cloudwatch-logs", "aws.cloudwatch-metrics", "aws.events", "loki", "prometheus"]);
    } finally { await server.close(); }
  });

  it("explicit endpoints still win over the platform environment", async () => {
    const server: TestServer = await startServer((_r, res) => json(res, {}));
    try {
      process.env.ZENITH_OBSERVE_LOKI_URL = server.url;
      const sources = sourcesForEnvironment({ provider: "sandbox", graph: graph([]), sessions: {}, endpoints: { prometheus: { baseUrl: server.url } } });
      expect(ids(sources)).toEqual(["prometheus", "sandbox.logsim"]);
    } finally { await server.close(); }
  });

  it("sends the configured token as a bearer header and the tenant header, never in the answer", async () => {
    const server: TestServer = await startServer((_req, res) => json(res, { status: "success", data: { resultType: "streams", result: [] } }));
    const token = ["observe", "token", "fixture"].join("-");
    try {
      process.env.ZENITH_OBSERVE_LOKI_URL = server.url;
      process.env.ZENITH_OBSERVE_LOKI_TOKEN = token;
      process.env.ZENITH_OBSERVE_LOKI_TENANT = "tenant-a";
      const lokiGraph = graph([node("service/web", "container_service", "kubernetes", { labels: { app: "web", namespace: "prod" } })]);
      const fabric = createObservabilityFabric(sourcesForEnvironment({ provider: "kubernetes", graph: lokiGraph, workspaceId: "ws-1", sessions: {} }), { now: () => new Date(NOW) });
      const answer = await fabric.searchLogs({ scope: scope(), range });
      expect(answer.telemetry?.provenance.map((p) => p.source)).toContain("loki");
      expect(JSON.stringify(answer)).not.toContain(token);
      expect(server.requests.length).toBeGreaterThan(0);
      for (const request of server.requests) { expect(request.headers.authorization).toBe(`Bearer ${token}`); expect(request.headers["x-scope-orgid"]).toBe("tenant-a"); }
    } finally { await server.close(); }
  });

  it("a malformed or metadata endpoint becomes an explicit unavailable source naming the variable, not a throw or a silent drop", async () => {
    process.env.ZENITH_OBSERVE_PROMETHEUS_URL = "http://169.254.169.254/latest";
    process.env.ZENITH_OBSERVE_LOKI_URL = "ftp://loki.internal:3100";
    const sources = sourcesForEnvironment({ provider: "sandbox", graph: graph([]), sessions: {} });
    expect(ids(sources)).toEqual(["loki", "prometheus", "sandbox.logsim"]);
    const answer = await createObservabilityFabric(sources, { now: () => new Date(NOW) }).searchLogs({ scope: scope(), range });
    const loki = answer.telemetry?.provenance.find((p) => p.source === "loki");
    expect(loki?.state).not.toBe("fresh");
    expect(JSON.stringify(answer.unavailable)).toContain("ZENITH_OBSERVE_LOKI_URL");
  });
});
