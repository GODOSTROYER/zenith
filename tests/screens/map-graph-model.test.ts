import { describe, expect, it } from "vitest";
import { buildGraph } from "@/components/map/graph-model";
import { emptyManifest, Service, Resource, type ChangeItem } from "@/lib/domain/types";

describe("removed map bindings", () => {
  const service = Service.parse({ id: "svc-original", name: "api", kind: "web", source: { type: "image", image: "nginx:latest" } });
  const duplicate = { ...service, id: "svc-duplicate" };
  const resource = Resource.parse({ id: "db", name: "db", kind: "postgres" });
  const deployed = { ...emptyManifest(), services: [service, duplicate], resources: [resource], bindings: [{ id: "binding", from: service.id, to: resource.id, capability: "sql" as const }] };
  const item: ChangeItem = { op: "delete", nodeType: "binding", nodeId: "binding", nodeName: "api → internal → db", costDeltaUsd: 0, explanation: "Remove this binding", risk: "low" };
  const working = { ...deployed, bindings: [] };
  const input = { manifest: working, changeset: { items: [item] }, health: undefined, deployed: true, liveTargets: [] };

  it("uses exact deployed endpoints despite ambiguous names and a stale display label", () => {
    const graph = buildGraph({ ...input, deployedManifest: deployed });
    expect(graph.allEdges).toMatchObject([{ id: "binding", source: "svc-original", target: "db", data: { capability: "sql", diff: "delete" } }]);
    expect(graph.allRaw.find((node) => node.id === "svc-duplicate")?.data.connections).toEqual([]);
  });

  it("does not invent a deleted connection when the deployed manifest is unavailable", () => {
    expect(buildGraph(input).allEdges).toEqual([]);
  });

  it("keeps an exact binding to a ghost resource", () => {
    const removal: ChangeItem = { ...item, nodeType: "resource", nodeId: "db", nodeName: "db" };
    const graph = buildGraph({ ...input, manifest: { ...working, resources: [] }, deployedManifest: deployed, changeset: { items: [item, removal] } });
    expect(graph.allEdges[0].target).toBe("db");
    expect(graph.allRaw.find((node) => node.id === "db")?.data.diff).toBe("delete");
  });

  it("keeps staged removals visible when the entire working configuration is empty", () => {
    const graph = buildGraph({ ...input, manifest: emptyManifest(), deployedManifest: deployed, changeset: { items: [{ ...item, nodeType: "resource", nodeId: "db", nodeName: "db" }] } });
    expect(graph.empty).toBe(false);
    expect(graph.allRaw).toHaveLength(1);
  });
});
