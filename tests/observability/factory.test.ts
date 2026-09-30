import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { KNOWN_SOURCE_IDS, sandboxSourceOf, sourcesForEnvironment } from "@/lib/observability/sources/factory";
import type { ProviderKey } from "@/lib/resources/types";
import { ARN, fakeAwsSession, fakeKubeSession, graph, node, scope } from "./_fixtures";
import { json, startServer, type TestServer } from "./_http";

const cw = mockClient(CloudWatchLogsClient);
beforeEach(() => cw.reset());

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const ids = (sources: { id: string }[]) => sources.map((s) => s.id).sort();

const awsGraph = graph([node("service/web", "container_service", "aws", { spec: { logGroup: "/ecs/prod/web" }, externalRef: ARN.ecsService("prod", "web"), labels: { app: "web" } })]);

describe("source selection", () => {
  it("sandbox -> the simulated logsim source", () => {
    const sources = sourcesForEnvironment({ provider: "sandbox", graph: graph([]), sessions: {} });
    expect(ids(sources)).toEqual(["sandbox.logsim"]);
    expect(sandboxSourceOf(sources)?.health).toBeTypeOf("function");
  });

  it("aws and localstack -> CloudWatch logs, CloudWatch metrics and ECS events, labeled with the provider", () => {
    for (const provider of ["aws", "localstack"] as ProviderKey[]) {
      const sources = sourcesForEnvironment({ provider, graph: awsGraph, sessions: { aws: fakeAwsSession() } });
      expect(ids(sources)).toEqual(["aws.cloudwatch-logs", "aws.cloudwatch-metrics", "aws.events"]);
      expect(sources.every((s) => s.provider === provider)).toBe(true);
    }
  });

  it("kubernetes -> the kubernetes source", () => {
    const sources = sourcesForEnvironment({ provider: "kubernetes", graph: graph([]), sessions: { kubernetes: fakeKubeSession({}) } });
    expect(ids(sources)).toEqual(["kubernetes"]);
  });

  it("adds Prometheus and Loki when endpoints are configured, for any provider", async () => {
    const server: TestServer = await startServer((_r, res) => json(res, {}));
    try {
      const sources = sourcesForEnvironment({
        provider: "aws",
        graph: awsGraph,
        sessions: { aws: fakeAwsSession() },
        endpoints: { prometheus: { baseUrl: server.url }, loki: { baseUrl: server.url } },
      });
      expect(ids(sources)).toEqual(["aws.cloudwatch-logs", "aws.cloudwatch-metrics", "aws.events", "loki", "prometheus"]);
    } finally {
      await server.close();
    }
  });

  it("every selected source id is a known one", () => {
    const sources = [
      ...sourcesForEnvironment({ provider: "sandbox", graph: graph([]), sessions: {} }),
      ...sourcesForEnvironment({ provider: "aws", graph: awsGraph, sessions: { aws: fakeAwsSession() } }),
      ...sourcesForEnvironment({ provider: "kubernetes", graph: graph([]), sessions: { kubernetes: fakeKubeSession({}) } }),
    ];
    for (const s of sources) expect(KNOWN_SOURCE_IDS as readonly string[]).toContain(s.id);
  });
});

describe("missing prerequisites are reported, not silent", () => {
  it("aws without a session answers every signal with an unavailable entry naming the source", async () => {
    const fabric = createObservabilityFabric(sourcesForEnvironment({ provider: "aws", graph: awsGraph, sessions: {} }), { now: () => new Date(NOW) });
    const logs = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(logs.items).toEqual([]);
    expect(logs.sources).toEqual([]);
    expect(logs.unavailable).toEqual([{ source: "aws.cloudwatch-logs", reason: expect.stringContaining("no AWS session") }]);
    const metrics = await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["cpu.utilization"] });
    expect(metrics.unavailable[0].source).toBe("aws.cloudwatch-metrics");
    const events = await fabric.searchEvents({ scope: scope(), range: range() });
    expect(events.unavailable[0].source).toBe("aws.events");
  });

  it("kubernetes without a session", async () => {
    const fabric = createObservabilityFabric(sourcesForEnvironment({ provider: "kubernetes", graph: graph([]), sessions: {} }), { now: () => new Date(NOW) });
    const r = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(r.unavailable).toEqual([{ source: "kubernetes", reason: expect.stringContaining("no Kubernetes session") }]);
  });

  it("providers without a native source say so for logs, metrics and events", async () => {
    for (const provider of ["gcp", "azure", "oci", "zenith"] as ProviderKey[]) {
      const fabric = createObservabilityFabric(sourcesForEnvironment({ provider, graph: graph([]), sessions: {} }), { now: () => new Date(NOW) });
      const r = await fabric.searchLogs({ scope: scope(), range: range() });
      expect(r.unavailable).toEqual([{ source: `observability.${provider}`, reason: `no native observability source is implemented for provider "${provider}"` }]);
      expect((await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["cpu.utilization"] })).unavailable).toHaveLength(1);
    }
  });
});

describe("tenant boundary", () => {
  it("sources bound to a workspace refuse other workspaces and other environments end to end", async () => {
    cw.on(FilterLogEventsCommand).resolves({ events: [{ timestamp: NOW - 60_000, message: "hello", eventId: "e1", logStreamName: "s" }] });
    const sources = sourcesForEnvironment({ provider: "aws", graph: awsGraph, workspaceId: "ws-1", sessions: { aws: fakeAwsSession() } });
    const fabric = createObservabilityFabric(sources, { now: () => new Date(NOW) });

    const ok = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(ok.items).toHaveLength(1);

    cw.resetHistory();
    for (const wrong of [{ workspaceId: "ws-other", environmentId: "env-1" }, { workspaceId: "ws-1", environmentId: "env-other" }]) {
      const r = await fabric.searchLogs({ scope: wrong, range: range() });
      expect(r.items).toEqual([]);
      expect(r.unavailable[0].source).toBe("fabric");
    }
    expect(cw.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });
});

describe("end to end across backends", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("merges CloudWatch and Loki logs, keeps both source ids, and a dead Prometheus is only an unavailable entry", async () => {
    cw.on(FilterLogEventsCommand).resolves({ events: [{ timestamp: NOW - 120_000, message: "ERROR from cloudwatch", eventId: "e1", logStreamName: "ecs/web/0123456789abcdef0123456789abcdef" }] });
    server = await startServer((_req, res) =>
      json(res, { status: "success", data: { resultType: "streams", result: [{ stream: { app: "web" }, values: [[String(BigInt(NOW - 30_000) * 1_000_000n), "WARN from loki"]] }] } })
    );
    const sources = sourcesForEnvironment({
      provider: "aws",
      graph: awsGraph,
      sessions: { aws: fakeAwsSession() },
      endpoints: { loki: { baseUrl: server.url }, prometheus: { baseUrl: "http://127.0.0.1:1" } },
    });
    const fabric = createObservabilityFabric(sources, { now: () => new Date(NOW), timeoutMs: 2000 });

    const logs = await fabric.searchLogs({ scope: scope(), range: range() });
    expect(logs.items.map((l) => l.message)).toEqual(["WARN from loki", "ERROR from cloudwatch"]);
    expect(logs.sources.sort()).toEqual(["aws.cloudwatch-logs", "loki"]);
    expect(logs.unavailable).toEqual([]);

    const metrics = await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["http.requests"] });
    expect(metrics.items).toEqual([]);
    expect(metrics.unavailable.map((u) => u.source).sort()).toContain("prometheus");
  });
});
