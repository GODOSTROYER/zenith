/** Independent contract regressions; real planners/guards, no cloud or database. */
import { describe, expect, it } from "vitest";
import { findGraphProblems } from "@/lib/execution/graph";
import { admitMixedGraph, isMixedAdmission } from "@/lib/execution/mixed/admission";
import { MixedPlanError } from "@/lib/execution/mixed/types";
import { DB, FN, WEB, candidates, mixedGraph, plan, refresh } from "./_fixtures";

const noDrivers = () => undefined;
const foreignProblems = (problems: string[]) => problems.filter((p) => p.includes("multi-provider graphs are not executable yet"));

function admittedFixture() {
  const graph = mixedGraph();
  const bound = candidates();
  const parent = plan({ graph, candidates: bound });
  const connections = new Map(bound.map((candidate) => [candidate.connection.id, candidate.connection]));
  const admission = admitMixedGraph({ plan: parent, graph, connections });
  return { graph, parent, connections, admission };
}

describe("mixed admission custody at graph consumption", () => {
  it("accepts unchanged graph content, including an equivalent copy", () => {
    const { graph, admission } = admittedFixture();
    expect(isMixedAdmission(admission)).toBe(true);
    expect(foreignProblems(findGraphProblems(graph, "aws", noDrivers, admission))).toEqual([]);
    expect(foreignProblems(findGraphProblems(structuredClone(graph), "aws", noDrivers, admission))).toEqual([]);
  });

  it("does not reuse an admission in another environment with identical addresses", () => {
    const { graph, admission } = admittedFixture();
    const other = { ...graph, environmentId: "env-not-reviewed" };
    expect(foreignProblems(findGraphProblems(other, "aws", noDrivers, admission))).toHaveLength(2);
  });

  it("does not reuse an admission after a refreshed configuration change", () => {
    const { graph, admission } = admittedFixture();
    const changed = structuredClone(graph);
    changed.nodes.find((node) => node.address === DB)!.spec.storageGb = 99;
    refresh(changed);
    expect(changed.graphDigest).not.toBe(graph.graphDigest);
    expect(foreignProblems(findGraphProblems(changed, "aws", noDrivers, admission))).toHaveLength(2);
  });

  it("does not trust stale digest fields after an in-place node mutation", () => {
    const { graph, admission } = admittedFixture();
    graph.nodes.find((node) => node.address === WEB)!.region = "unreviewed-region";
    expect(foreignProblems(findGraphProblems(graph, "aws", noDrivers, admission))).toHaveLength(2);
  });

  it("cannot widen the graph by adding to the caller-visible address set", () => {
    const { graph, admission } = admittedFixture();
    const extra = { ...structuredClone(graph.nodes.find((node) => node.address === WEB)!), address: "service/not-reviewed" };
    graph.nodes.push(extra);
    refresh(graph);
    (admission.addresses as Set<string>).add(extra.address);
    expect(foreignProblems(findGraphProblems(graph, "aws", noDrivers, admission))).toHaveLength(3);
  });

  it("does not treat a changed provider with stale digests as the reviewed node", () => {
    const { graph, admission } = admittedFixture();
    graph.nodes.find((node) => node.address === FN)!.provider = "azure";
    expect(foreignProblems(findGraphProblems(graph, "aws", noDrivers, admission))).toHaveLength(3);
  });

  it("rejects a duplicate node substituted for another covered address at minting", () => {
    const { graph, parent, connections } = admittedFixture();
    const web = graph.nodes.find((node) => node.address === WEB)!;
    graph.nodes[graph.nodes.findIndex((node) => node.address === DB)] = structuredClone(web);
    // Cardinality and stored digests alone cannot detect this omitted address.
    expect(() => admitMixedGraph({ plan: parent, graph, connections })).toThrow(MixedPlanError);
  });

  it("keeps cloned admission objects unauthenticated", () => {
    const { graph, admission } = admittedFixture();
    const clone = { ...admission };
    expect(isMixedAdmission(clone)).toBe(false);
    expect(foreignProblems(findGraphProblems(graph, "aws", noDrivers, clone))).toHaveLength(2);
  });

  it("still runs ordinary driver validation after accepting the graph", () => {
    const { graph, admission } = admittedFixture();
    const problems = findGraphProblems(graph, "aws", noDrivers, admission);
    expect(foreignProblems(problems)).toEqual([]);
    expect(problems.filter((p) => p.includes("no driver is registered"))).toHaveLength(3);
  });
});
