/** Additional positive and negative content-binding controls; no external resources. */
import { describe, expect, it } from "vitest";
import { admitMixedGraph, isMixedAdmissionForGraph } from "@/lib/execution/mixed/admission";
import { MixedPlanError } from "@/lib/execution/mixed/types";
import { DB, candidates, mixedGraph, plan } from "./_fixtures";

function fixture() {
  const graph = mixedGraph();
  const bound = candidates();
  const parent = plan({ graph, candidates: bound });
  const connections = new Map(bound.map((candidate) => [candidate.connection.id, candidate.connection]));
  return { graph, parent, connections, admission: admitMixedGraph({ plan: parent, graph, connections }) };
}

describe("mixed admission content integrity", () => {
  it("accepts canonical-equivalent node and edge permutations without mutating them", () => {
    const { graph, admission } = fixture();
    const reordered = structuredClone(graph);
    reordered.nodes.reverse(); reordered.edges.reverse();
    const before = structuredClone(reordered);
    expect(isMixedAdmissionForGraph(admission, reordered)).toBe(true);
    expect(reordered).toEqual(before);
  });

  it("rejects an edge mutation even when caller-maintained digests are unchanged", () => {
    const { graph, admission } = fixture();
    graph.edges[0].detail = "not-reviewed";
    expect(isMixedAdmissionForGraph(admission, graph)).toBe(false);
  });

  it("rejects a changed external resource reference not included in specDigest", () => {
    const { graph, admission } = fixture();
    graph.nodes.find((node) => node.address === DB)!.externalRef = "unreviewed-database";
    expect(isMixedAdmissionForGraph(admission, graph)).toBe(false);
  });

  it("keeps public address snapshots separate from the private admission binding", () => {
    const { graph, admission } = fixture();
    const original = [...admission.addresses];
    const snapshot = admission.addresses as Set<string>;
    snapshot.clear(); snapshot.add("service/not-reviewed");
    expect([...admission.addresses]).toEqual(original);
    expect(isMixedAdmissionForGraph(admission, graph)).toBe(true);
  });

  it("refuses stale node content when minting as well as when consuming", () => {
    const { graph, parent, connections } = fixture();
    graph.nodes.find((node) => node.address === DB)!.spec.storageGb = 99;
    expect(() => admitMixedGraph({ plan: parent, graph, connections })).toThrow(MixedPlanError);
  });

  it("refuses stale edge content when minting", () => {
    const { graph, parent, connections } = fixture();
    graph.edges[0].detail = "not-reviewed";
    expect(() => admitMixedGraph({ plan: parent, graph, connections })).toThrow(MixedPlanError);
  });
});
