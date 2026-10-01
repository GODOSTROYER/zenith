/** The factory's production API path keeps the provider namespace guard; all clients are mocked. */
import { beforeEach, expect, it, vi } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { sourcesForEnvironment } from "@/lib/observability/sources/factory";
import { fakeKubeSession, graph, node, recentRange, scope } from "./_fixtures";

const fixture = vi.hoisted(() => ({
  allowed: true,
  assert: vi.fn(),
  pods: vi.fn(),
  logs: vi.fn(),
  events: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/providers/kubernetes/client", () => ({ createK8sClient: fixture.create }));
beforeEach(() => {
  fixture.allowed = true; vi.clearAllMocks();
  fixture.assert.mockImplementation(async () => { if (!fixture.allowed) throw new Error("Namespace is not owned by this environment."); });
  fixture.pods.mockResolvedValue({ items: [{ metadata: { name: "web-pod" }, spec: { containers: [{ name: "web" }] } }] });
  fixture.logs.mockImplementation(async () => `${new Date(Date.now() - 1000).toISOString()} ERROR connection refused`);
  fixture.events.mockResolvedValue({ items: [] });
  fixture.create.mockResolvedValue({ guard: { assert: fixture.assert }, core: { listNamespacedPod: fixture.pods, readNamespacedPodLog: fixture.logs, listNamespacedEvent: fixture.events } });
});
const fabric = () => createObservabilityFabric(sourcesForEnvironment({ provider: "kubernetes", workspaceId: "ws-1", graph: graph([node("service/web", "container_service", "kubernetes", { spec: { namespace: "customer-app" } })]), sessions: { kubernetes: fakeKubeSession({}) } }));

it("refuses namespace reads outside the connection and environment ownership before fetching logs", async () => {
  fixture.allowed = false;
  const result = await fabric().searchLogs({ scope: scope(), range: recentRange() });
  expect(result.items).toEqual([]); expect(result.unavailable[0]?.reason).toContain("not owned");
  expect(fixture.assert).toHaveBeenCalledWith("customer-app"); expect(fixture.pods).not.toHaveBeenCalled(); expect(fixture.logs).not.toHaveBeenCalled();
});

it("reads an owned namespace only after checking it through the provider guard", async () => {
  const result = await fabric().searchLogs({ scope: scope(), range: recentRange() });
  expect(result.items).toHaveLength(1);
  expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ provider: "kubernetes" }), { environmentId: "env-1", requestTimeoutMs: 6000 });
  expect(fixture.assert.mock.invocationCallOrder[0]).toBeLessThan(fixture.pods.mock.invocationCallOrder[0]);
  expect(fixture.assert.mock.invocationCallOrder[1]).toBeLessThan(fixture.logs.mock.invocationCallOrder[0]);
});
