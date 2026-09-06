import { describe, expect, it } from "vitest";
import { buildRehearsalModel } from "@/components/spatial/rehearsal-model";
import { emptyManifest, Resource, type Changeset, type Manifest } from "@/lib/domain/types";

const resource = (id: string) => Resource.parse({ id, name: `resource-${id}`, kind: "queue" });
const changes: Changeset = { items: [{ nodeId: "binding", nodeType: "binding", nodeName: "connection", op: "update", costDeltaUsd: 0, risk: "low", explanation: "Change destination" }], projectedMonthlyUsd: 12, totalCostDeltaUsd: 2, warnings: [] };
const current: Manifest = { ...emptyManifest(), resources: [resource("a"), resource("b"), resource("c")], bindings: [{ id: "binding", from: "a", to: "b", capability: "queue_publish" }] };
const proposed: Manifest = { ...current, bindings: [{ id: "binding", from: "a", to: "c", capability: "queue_publish" }] };

describe("authoritative change rehearsal projection", () => {
  it("preserves both endpoint pairs when a binding is retargeted", () => {
    const model = buildRehearsalModel(current, proposed, changes, "binding");
    expect(model.selectedNodes).toEqual(["a", "b", "c"]);
    expect(model.nodes.every((node) => node.affected)).toBe(true);
    expect(model.bindings[0].current?.to).toBe("b");
    expect(model.bindings[0].proposed?.to).toBe("c");
  });
  it("retains removed nodes and their exact current identity", () => {
    const model = buildRehearsalModel(current, emptyManifest(), { ...changes, items: [{ ...changes.items[0], nodeId: "a", nodeType: "resource", op: "delete" }] }, "a");
    expect(model.nodes.find((node) => node.id === "a")).toMatchObject({ current: true, proposed: false, currentName: "resource-a", change: "delete" });
    expect(model.bindings[0].proposed).toBeUndefined();
  });
  it("does not move unchanged included nodes as selection changes", () => {
    const large = { ...emptyManifest(), resources: Array.from({ length: 30 }, (_, index) => resource(String(index).padStart(2, "0"))) };
    const first = buildRehearsalModel(large, large, { ...changes, items: [] }, "00");
    const next = buildRehearsalModel(large, large, { ...changes, items: [] }, "29");
    expect(next.nodes).toHaveLength(12);
    expect(next.allNodes).toHaveLength(30);
    expect(next.omitted).toBe(18);
    expect(next.nodes.some((node) => node.id === "29")).toBe(true);
    for (const node of first.nodes.slice(0, 11)) expect(next.nodes.find((value) => value.id === node.id)).toMatchObject({ x: node.x, z: node.z });
  });
  it("does not mutate manifests or changesets while creating presentation positions", () => {
    const before = JSON.stringify({ current, proposed, changes });
    buildRehearsalModel(current, proposed, changes, "binding");
    expect(JSON.stringify({ current, proposed, changes })).toBe(before);
  });
  it("represents an undeployed environment without manufacturing a current graph", () => {
    const model = buildRehearsalModel(null, proposed, changes, null);
    expect(model.nodes.every((node) => !node.current && node.proposed)).toBe(true);
    expect(model.bindings.every((binding) => !binding.current)).toBe(true);
  });
});
