/** Fake drivers/in-memory store; scans every public and persisted surface. */
import { describe, expect, it } from "vitest";
import { reconcileEnvironment } from "@/lib/reconcile";
import { ENV, harness, persistedText, tinyGraph } from "./_support";
import { assertNoCanaries, canarySecret } from "../_support/security";

describe("desired drift value boundary", () => {
  it.each(["aws-access-key-id", "jwt", "pem-private-key"] as const)("scrubs nested desired %s values without mutating the driver answer", async (shape) => {
    const secret = canarySecret(`reconcile-desired-${shape}`, shape);
    const expected = { diagnostic: { nested: [secret] } };
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (world, graph) => {
      world.allPresent(graph, { diagnostic: { nested: ["reference-only"] } });
      for (const node of graph.nodes) world.patch(node.address, { expected });
    } });
    const graph = await h.ports.loadGraph(ENV);
    const out = await reconcileEnvironment({ environment: ENV, graph: graph!, ports: h.ports });
    expect(out.report?.findings.length).toBeGreaterThan(0);
    expect(expected.diagnostic.nested).toEqual([secret]);
    expect(h.backend.events.some((event) => event.type === "drift.detected")).toBe(true);
    assertNoCanaries([out, persistedText(h.backend)], [secret], "desired values are scrubbed before persistence, events and returns");
    for (const event of h.backend.events.filter((event) => event.type === "drift.detected")) {
      expect(event.data.attributes).toEqual(["diagnostic"]);
      expect(event.data).not.toHaveProperty("desired");
      expect(event.data).not.toHaveProperty("observed");
    }
  });

  it("keeps ordinary desired/observed drift values", async () => {
    const h = harness({ graph: tinyGraph(ENV.environmentId), world: (world, graph) => {
      world.allPresent(graph, { replicas: 3 });
      for (const node of graph.nodes) world.patch(node.address, { expected: { replicas: 2 } });
    } });
    const graph = await h.ports.loadGraph(ENV);
    const out = await reconcileEnvironment({ environment: ENV, graph: graph!, ports: h.ports });
    expect(out.report?.findings[0].fields).toEqual([{ attribute: "replicas", desired: 2, observed: 3 }]);
  });
});
