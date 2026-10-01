/** Provider sources through the real factory/fabric; all HTTP and Kubernetes evidence is synthetic. */
import { describe, expect, it, vi } from "vitest";
import type { AzureSession, GcpSession } from "@/lib/credentials/types";
import { sourcesForEnvironment } from "@/lib/observability/sources/factory";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { KubernetesCoreApi } from "@/lib/observability/sources/kubernetes";
import type { Observation } from "@/lib/resources/types";
import type { OciSession } from "@/lib/providers/oci/transport";
import { CANARY, fakeKubeSession, graph, node, recentRange, scope, WS, ENV } from "./_fixtures";

const at = new Date().toISOString();
const observation = (address: string, externalId: string, native?: Record<string, unknown>): Observation => ({ address, externalId, presence: "present", attributes: {}, native, observedAt: at, source: "contract-fixture", simulated: false });

describe("additional provider source wiring", () => {
  it("queries Google logs and metrics for observed resources and redacts logs", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("logging.googleapis.com")
      ? Response.json({ entries: [{ timestamp: at, severity: "ERROR", textPayload: `password=${CANARY.password} database connection refused`, resource: { type: "cloud_run_revision", labels: { service_name: "web", location: "us-central1" } }, logName: "projects/sample-project/logs/run.googleapis.com%2Fstderr" }] })
      : Response.json({ timeSeries: [{ metric: { type: "run.googleapis.com/request_count" }, resource: { labels: { service_name: "web" } }, points: [{ interval: { endTime: at }, value: { doubleValue: 12 } }] }] }));
    const session: GcpSession = { provider: "gcp", projectId: "sample-project", region: "us-central1", expiresAt: at, authorizedFetch: fetch, childProcessEnv: () => ({}) };
    const sources = sourcesForEnvironment({ provider: "gcp", workspaceId: WS, graph: graph([node("service/web", "container_service", "gcp", { nativeType: "gcp:cloud_run_service" })]), sessions: { gcp: session },
      observations: [observation("service/web", "projects/sample-project/locations/us-central1/services/web")] });
    const fabric = createObservabilityFabric(sources);
    const logs = await fabric.searchLogs({ scope: scope(), range: recentRange() });
    expect(logs.items).toHaveLength(1); expect(logs.sources).toContain("gcp.cloud-logging");
    expect(JSON.stringify(logs)).not.toContain(CANARY.password);
    const metrics = await fabric.queryMetrics({ scope: scope(), range: recentRange(), metrics: ["http.requests"] });
    expect(metrics.items[0]?.points[0]?.value).toBe(12);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("queries Azure logs and metrics using recorded ARM and workspace identifiers", async () => {
    const fetch = vi.fn(async (url: string) => url.includes("api.loganalytics.io")
      ? Response.json({ tables: [{ columns: [{ name: "TimeGenerated" }, { name: "ContainerAppName_s" }, { name: "Log_s" }], rows: [[at, "web", `password=${CANARY.password} connection refused`]] }] })
      : Response.json({ value: [{ timeseries: [{ data: [{ timeStamp: at, average: 2 }] }] }] }));
    const session: AzureSession = { provider: "azure", subscriptionId: "11111111-1111-1111-1111-111111111111", region: "eastus", expiresAt: at, authorizedFetch: fetch, childProcessEnv: () => ({}) };
    const armId = `/subscriptions/${session.subscriptionId}/resourceGroups/app/providers/Microsoft.App/containerApps/web`;
    const sources = sourcesForEnvironment({ provider: "azure", workspaceId: WS, graph: graph([node("service/web", "container_service", "azure"), node("log_group/web", "log_group", "azure", { spec: { workload: "service/web" } })]), sessions: { azure: session },
      observations: [observation("service/web", armId), observation("log_group/web", "workspace-resource", { customerId: "22222222-2222-2222-2222-222222222222" })] });
    const fabric = createObservabilityFabric(sources);
    const logs = await fabric.searchLogs({ scope: scope(), range: recentRange() });
    expect(logs.items).toHaveLength(1); expect(logs.sources).toEqual(["azure.log-analytics"]); expect(JSON.stringify(logs)).not.toContain(CANARY.password);
    const metrics = await fabric.queryMetrics({ scope: scope(), range: recentRange(), metrics: ["replica.count"] });
    expect(metrics.items[0]?.points[0]?.value).toBe(2); expect(metrics.sources).toEqual(["azure.monitor-metrics"]);
  });

  it.each(["gcp", "azure"] as const)("%s refuses foreign scopes even on a directly called source", async (provider) => {
    const fetch = vi.fn(async () => Response.json({}));
    const sources = sourcesForEnvironment({ provider, workspaceId: WS, graph: graph([node("service/web", "container_service", provider)]), sessions: provider === "gcp"
      ? { gcp: { provider, projectId: "sample-project", region: "us-central1", expiresAt: at, authorizedFetch: fetch, childProcessEnv: () => ({}) } }
      : { azure: { provider, subscriptionId: "11111111-1111-1111-1111-111111111111", region: "eastus", expiresAt: at, authorizedFetch: fetch, childProcessEnv: () => ({}) } } });
    for (const foreign of [scope({ workspaceId: "foreign" }), scope({ environmentId: "foreign" })]) {
      expect((await sources[0].searchLogs!({ scope: foreign, range: recentRange() }, new AbortController().signal)).items).toEqual([]);
      expect((await createObservabilityFabric(sources).searchLogs({ scope: foreign, range: recentRange() })).unavailable[0]?.source).toBe("fabric");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads managed cluster logs only in the derived tenant namespace with provider identity preserved", async () => {
    const namespace = tenantNamespace(WS, ENV);
    const api: KubernetesCoreApi = { listNamespacedPod: vi.fn(async () => ({ items: [{ metadata: { name: "web-pod" }, spec: { containers: [{ name: "web" }] } }] })),
      readNamespacedPodLog: vi.fn(async () => `${at} ERROR connection refused`), listNamespacedEvent: vi.fn(async () => ({ items: [] })) };
    const session = { ...fakeKubeSession({}), namespaces: [namespace] };
    const sources = sourcesForEnvironment({ provider: "zenith", workspaceId: WS, graph: graph([node("service/web", "container_service", "zenith", { spec: { namespace: "foreign-namespace" } })]), sessions: { kubernetes: session }, kubernetes: { api: () => api } });
    const logs = await createObservabilityFabric(sources).searchLogs({ scope: scope(), range: recentRange() });
    expect(logs.items[0]).toMatchObject({ provider: "zenith", address: "service/web" }); expect(logs.sources).toEqual(["zenith.kubernetes"]);
    expect(api.listNamespacedPod).toHaveBeenCalledWith(expect.objectContaining({ namespace, labelSelector: expect.stringContaining("app.kubernetes.io/name=") }));
    const denied = sourcesForEnvironment({ provider: "zenith", workspaceId: WS, graph: graph([]), sessions: { kubernetes: fakeKubeSession({}) } });
    expect((await createObservabilityFabric(denied).searchLogs({ scope: scope(), range: recentRange() })).unavailable[0]?.reason).toContain("tenant");
  });

  it("OCI is explicitly unavailable without a runner and with the current unsupported runner signal contract", async () => {
    const request = vi.fn();
    const session: OciSession = { provider: "oci", region: "us-ashburn-1", compartmentOcid: "ocid1.compartment.oc1..contract", transport: { request } };
    for (const oci of [undefined, session]) {
      const sources = sourcesForEnvironment({ provider: "oci", workspaceId: WS, graph: graph([]), sessions: { oci } });
      const fabric = createObservabilityFabric(sources);
      const logs = await fabric.searchLogs({ scope: scope(), range: recentRange() });
      const metrics = await fabric.queryMetrics({ scope: scope(), range: recentRange(), metrics: ["cpu.utilization"] });
      expect(logs).toMatchObject({ items: [], simulated: false, unavailable: [{ source: "oci.logging" }] });
      expect(metrics).toMatchObject({ items: [], simulated: false, unavailable: [{ source: "oci.monitoring" }] });
      expect(logs.unavailable[0].reason).toMatch(oci ? /Logging Search/ : /no OCI runner session/);
      expect(metrics.unavailable[0].reason).toMatch(oci ? /Monitoring/ : /no OCI runner session/);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
