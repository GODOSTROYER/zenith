/**
 * PROD-MIX-01 / PROD-MIX-02, contract and local-engine level: partitioning by
 * provider, account, region and backend; binding verified connections; the parent
 * plan as an ordered set of immutable child subplans; the child-set digest the
 * approval binds; stable addresses; and the admission that replaces the
 * cross-provider refusal. Pure code over the real graph builder; no cloud, no
 * database. The cloud-facing behaviour is the live harness (gated, see
 * tests/live/mixed-cloud.live.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "@/lib/credentials/types";
import { findGraphProblems } from "@/lib/execution/graph";
import { assertAddressesStable, deriveAddresses, partitionKey, stableAddress } from "@/lib/execution/mixed/addresses";
import { admitMixedGraph, isMixedAdmission } from "@/lib/execution/mixed/admission";
import { mixedProposalDetails } from "@/lib/execution/mixed/details";
import { assertParentPlanIntegrity, buildParentPlan, childSemanticsDigest, childSetDigest, parentProposalInput, proposalMatchesPlan } from "@/lib/execution/mixed/parent-plan";
import { MixedPlanError, type MixedPlanErrorCode } from "@/lib/execution/mixed/types";
import { reverifyAuthority, verifyChildGraph } from "@/lib/execution/mixed/verify";
import { buildReceipt, outcomeOfOperationStatus, receiptDigestOf } from "@/lib/execution/mixed/receipt";
import { ACCOUNT, DB, FN, PARENT_ENV, PROJECT, WEB, WS, candidates, connection, mixedGraph, plan, refresh, twoAwsGraph } from "./_fixtures";

function refusal(fn: () => unknown, code: MixedPlanErrorCode): MixedPlanError {
  let failure: unknown;
  try { fn(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(MixedPlanError);
  expect((failure as MixedPlanError).code).toBe(code);
  return failure as MixedPlanError;
}

const connectionMap = (parent = plan()): Map<string, ProviderConnection | null> => new Map<string, ProviderConnection | null>(parent.children.map((child) => [child.authority.connectionId, connection(child.authority.provider as "aws" | "gcp" | "azure", { id: child.authority.connectionId })]));

describe("partitioning by provider, account, region and backend (MIX-01)", () => {
  it("makes one child per bound connection, ordered by dependency, each with its own backend and identity", () => {
    const parent = plan();
    expect(parent.children.map((child) => child.authority.provider)).toEqual(["azure", "gcp", "aws"]);
    expect(parent.children.map((child) => child.childEnvironmentId)).toEqual(["env-azure", "env-gcp", "env-aws"]);
    expect(parent.executionOrder).toEqual(parent.children.map((child) => child.partitionId));
    expect(parent.teardownOrder).toEqual([...parent.executionOrder].reverse());
    expect(new Set(parent.children.map((child) => child.authority.backendDigest)).size).toBe(3);
    expect(new Set(parent.children.map((child) => child.authority.connectionIdentityDigest)).size).toBe(3);
    expect(new Set(parent.children.map((child) => child.authority.stateLocationDigest)).size).toBe(3);
    expect(parent.children.map((child) => child.authority.backendKind)).toEqual(["azurerm", "gcs", "s3"]);
    expect(parent.children[1].dependsOn).toEqual([parent.children[0].partitionId]);
    expect(parent.children[2].dependsOn).toEqual([parent.children[1].partitionId]);
    const nodes = parent.children.flatMap((child) => child.nodes.map((node) => node.address)).sort();
    expect(nodes).toEqual([DB, FN, WEB].sort());
    for (const child of parent.children) {
      expect(child.authority.accountId.length).toBeGreaterThan(0);
      expect(child.blockedByReferences).toEqual([]);
    }
  });

  it("keeps each state backend under its own child environment's prefix", () => {
    const parent = plan();
    expect(parent.children.every((child) => child.authority.stateEnvironmentId === child.childEnvironmentId)).toBe(true);
  });

  it("is deterministic under candidate and node permutation", () => {
    const first = plan();
    const graph = mixedGraph(); graph.nodes.reverse(); graph.edges.reverse();
    const second = plan({ graph, candidates: candidates().reverse() });
    expect(second).toEqual(first);
  });

  it("refuses a graph with a (provider, region) that no verified connection is bound for", () => {
    const error = refusal(() => plan({ candidates: candidates().filter((c) => c.childEnvironmentId !== "env-aws") }), "unbound_partition");
    expect(error.message).toContain("aws/us-east-1");
  });

  it("refuses to guess between two connections that can host a node, and a pin resolves only a real ambiguity", () => {
    const two = [
      { childEnvironmentId: "env-a1", connection: connection("aws", { id: "conn-a1" }) },
      { childEnvironmentId: "env-a2", connection: connection("aws", { id: "conn-a2" }) },
    ];
    refusal(() => plan({ graph: twoAwsGraph(), candidates: two }), "ambiguous_partition");
    const pinned = plan({ graph: twoAwsGraph(), candidates: two, pins: [{ address: "service/a", childEnvironmentId: "env-a1" }, { address: "service/b", childEnvironmentId: "env-a2" }] });
    expect(pinned.children).toHaveLength(2);
    expect(pinned.children.map((child) => child.childEnvironmentId).sort()).toEqual(["env-a1", "env-a2"]);
    // a pin to a child that cannot host the node
    refusal(() => plan({ candidates: candidates(), pins: [{ address: DB, childEnvironmentId: "env-aws" }] }), "child_mismatch");
    refusal(() => plan({ graph: twoAwsGraph(), candidates: two, pins: [{ address: "service/missing", childEnvironmentId: "env-a1" }, { address: "service/a", childEnvironmentId: "env-a1" }, { address: "service/b", childEnvironmentId: "env-a1" }] }), "child_mismatch");
  });

  it("refuses a bound child that hosts nothing", () => {
    refusal(() => plan({ candidates: [...candidates(), { childEnvironmentId: "env-extra", connection: connection("aws", { id: "conn-extra" }) }] }), "ambiguous_partition");
    const extra = connection("aws", { id: "conn-extra" });
    if (extra.config.provider === "aws") extra.config.region = "eu-west-1";
    refusal(() => plan({ candidates: [...candidates(), { childEnvironmentId: "env-extra", connection: extra }] }), "child_mismatch");
  });

  it("binds only verified, unrevoked connections of this workspace", () => {
    refusal(() => plan({ candidates: candidates({ aws: connection("aws", { status: "pending_verification" }) }) }), "connection_unverified");
    refusal(() => plan({ candidates: candidates({ gcp: connection("gcp", { status: "failed" }) }) }), "connection_unverified");
    refusal(() => plan({ candidates: candidates({ azure: connection("azure", { status: "revoked" }) }) }), "connection_unverified");
    refusal(() => plan({ candidates: candidates({ aws: connection("aws", { workspaceId: "other-workspace" }) }) }), "connection_foreign");
  });

  it("refuses a connection whose state backend is unknown, and never infers one", () => {
    refusal(() => plan({ candidates: candidates({ aws: connection("aws", { noBucket: true }) }) }), "backend_refused");
  });

  it("refuses an environment bound twice and an empty child set", () => {
    const list = candidates();
    refusal(() => plan({ candidates: [...list, list[0]] }), "invalid_input");
    refusal(() => plan({ candidates: [] }), "unbound_partition");
  });

  it("surfaces planner refusals (a cross-partition data edge without a typed reference) with only the fixed code", () => {
    const graph = mixedGraph();
    graph.edges.push({ from: WEB, to: DB, relation: "connects_to" });
    refresh(graph);
    const error = refusal(() => plan({ graph }), "plan_refused");
    expect(error.detail).toEqual({ code: "reference_contract" });
  });

  it("declared references start unavailable and block their consumers", () => {
    const graph = mixedGraph();
    graph.edges.push({ from: WEB, to: DB, relation: "connects_to" });
    refresh(graph);
    const parent = plan({ graph, references: [{ id: "db-host", producer: { address: DB, output: "endpoint", type: "endpoint" }, consumer: { address: WEB, input: "endpoint_db", type: "endpoint" } }] });
    const web = parent.children.find((child) => child.nodes.some((node) => node.address === WEB))!;
    const fn = parent.children.find((child) => child.nodes.some((node) => node.address === FN))!;
    expect(web.blockedByReferences).toEqual(["db-host"]);
    expect(fn.blockedByReferences).toEqual(["db-host"]);
    expect(parent.references[0]).toMatchObject({ referenceId: "db-host", state: "unavailable", unavailableReason: "not_produced" });
  });
});

describe("parent plan: immutable ordered child subplans and the approved set (MIX-02)", () => {
  it("each child carries its own semantics digest and the parent binds the whole ordered set", () => {
    const parent = plan();
    for (const child of parent.children) expect(child.semanticsDigest).toBe(childSemanticsDigest(child));
    expect(new Set(parent.children.map((child) => child.semanticsDigest)).size).toBe(3);
    expect(parent.childSetDigest).toBe(childSetDigest(parent.children, parent.executionOrder));
    expect(() => assertParentPlanIntegrity(parent)).not.toThrow();
  });

  it("a different set, order or child digest is a different approval", () => {
    const parent = plan();
    const reordered = [...parent.children].reverse().map((child, index) => ({ ...child, ordinal: index }));
    expect(childSetDigest(reordered, [...parent.executionOrder].reverse())).not.toBe(parent.childSetDigest);
    const edited = parent.children.map((child, index) => (index === 1 ? { ...child, subplanDigest: "0".repeat(64) } : child));
    expect(childSetDigest(edited, parent.executionOrder)).not.toBe(parent.childSetDigest);
    const graph = mixedGraph(); graph.nodes.find((node) => node.address === FN)!.spec.sourceService = "service/other"; refresh(graph);
    expect(plan({ graph }).childSetDigest).not.toBe(parent.childSetDigest);
  });

  it("a changed connection identity changes the affected child's semantics digest, so the approval no longer matches", () => {
    const before = plan();
    const after = plan({ candidates: candidates({ aws: connection("aws", { deployRole: `arn:aws:iam::${ACCOUNT}:role/other-deploy` }) }) });
    const b = before.children.find((child) => child.authority.provider === "aws")!;
    const a = after.children.find((child) => child.authority.provider === "aws")!;
    expect(a.semanticsDigest).not.toBe(b.semanticsDigest);
    expect(after.childSetDigest).not.toBe(before.childSetDigest);
    const other = before.children.find((child) => child.authority.provider === "gcp")!;
    expect(after.children.find((child) => child.authority.provider === "gcp")!.semanticsDigest).toBe(other.semanticsDigest);
  });

  it("proposal input is exactly the plan: any difference is not the approved proposal", () => {
    const parent = plan();
    const input = parentProposalInput(parent);
    expect(proposalMatchesPlan(JSON.parse(JSON.stringify(input)), parent)).toBe(true);
    expect(input.children.map((child) => child.ordinal)).toEqual([0, 1, 2]);
    const withDigest = (mutate: (copy: ReturnType<typeof parentProposalInput>) => void) => { const copy = JSON.parse(JSON.stringify(input)) as ReturnType<typeof parentProposalInput>; mutate(copy); return copy; };
    expect(proposalMatchesPlan(withDigest((c) => { (c.children as unknown as { semanticsDigest: string }[])[0].semanticsDigest = "1".repeat(64); }), parent)).toBe(false);
    expect(proposalMatchesPlan(withDigest((c) => { (c as { childSetDigest: string }).childSetDigest = "2".repeat(64); }), parent)).toBe(false);
    expect(proposalMatchesPlan(withDigest((c) => { (c as unknown as { extra: boolean }).extra = true; }), parent)).toBe(false);
    expect(proposalMatchesPlan(withDigest((c) => { (c as unknown as { children: unknown[] }).children = c.children.slice(1); }), parent)).toBe(false);
    expect(proposalMatchesPlan({ mixedParentPlanId: "other" }, parent)).toBe(false);
    expect(proposalMatchesPlan(null, parent)).toBe(false);
    expect(proposalMatchesPlan([], parent)).toBe(false);
  });

  it("the plan id is a function of its content, so the same plan is the same id", () => {
    expect(plan().parentPlanId).toBe(plan().parentPlanId);
    const graph = mixedGraph(); graph.nodes.find((node) => node.address === DB)!.spec.storageGb = 64; refresh(graph);
    expect(plan({ graph }).parentPlanId).not.toBe(plan().parentPlanId);
  });

  it("integrity check catches tampered semantics digests, order, child set and teardown", () => {
    const clone = () => structuredClone(plan());
    let tampered = clone(); (tampered.children[0] as { semanticsDigest: string }).semanticsDigest = "3".repeat(64);
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
    tampered = clone(); (tampered as unknown as { executionOrder: string[] }).executionOrder = [...tampered.executionOrder].reverse();
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
    tampered = clone(); (tampered as { childSetDigest: string }).childSetDigest = "4".repeat(64);
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
    tampered = clone(); (tampered as unknown as { teardownOrder: string[] }).teardownOrder = [...tampered.executionOrder];
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
    tampered = clone(); (tampered as { format: string }).format = "zenith.other.v1";
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
    tampered = clone(); (tampered.children[0] as unknown as { dependsOn: string[] }).dependsOn = [tampered.children[2].partitionId];
    refusal(() => assertParentPlanIntegrity(tampered), "plan_refused");
  });

  it("approver-facing details name the plan, the child set digest and every child in order", () => {
    const parent = plan();
    const lines = mixedProposalDetails(parentProposalInput(parent));
    expect(lines[0]).toContain(parent.parentPlanId);
    expect(lines[1]).toContain(parent.childSetDigest.slice(0, 16));
    expect(lines.filter((line) => /^Child \d+:/.test(line))).toHaveLength(3);
    expect(lines.join("\n")).toContain("env-azure");
    expect(mixedProposalDetails({ capability: "x" })).toEqual([]);
    expect(mixedProposalDetails(null)).toEqual([]);
    expect(mixedProposalDetails({ mixedParentPlanId: 3 })).toEqual([]);
  });
});

describe("stable resource addresses (MIX-02)", () => {
  it("do not depend on partition ids, connection ids or binding ids, so they survive rotation and re-planning", () => {
    const first = plan();
    const second = plan({ candidates: candidates({ aws: connection("aws", { id: "conn-aws-rotated" }), gcp: connection("gcp", { id: "conn-gcp-rotated" }) }) });
    expect(second.children.map((child) => child.partitionId)).not.toEqual(first.children.map((child) => child.partitionId));
    expect(second.addresses.map((entry) => entry.stableAddress)).toEqual(first.addresses.map((entry) => entry.stableAddress));
    expect(first.addresses).toHaveLength(3);
    for (const entry of first.addresses) expect(entry.stableAddress).toContain(`::${entry.address}`);
  });

  it("derive from provider, region and a digest of the account, never the raw account", () => {
    const key = partitionKey({ provider: "aws", accountId: ACCOUNT, region: "us-east-1" });
    expect(key.startsWith("aws:us-east-1:")).toBe(true);
    expect(key).not.toContain(ACCOUNT);
    expect(stableAddress({ provider: "aws", accountId: ACCOUNT, region: "us-east-1" }, FN)).toBe(`${key}::${FN}`);
    expect(partitionKey({ provider: "aws", accountId: "999999999999", region: "us-east-1" })).not.toBe(key);
  });

  it("a stored registry equal to a fresh derivation is stable; any drift is refused", () => {
    const parent = plan();
    expect(() => assertAddressesStable(parent.addresses, deriveAddresses(parent.children))).not.toThrow();
    const moved = parent.addresses.map((entry, index) => (index === 0 ? { ...entry, partitionId: "partition/other" } : entry));
    refusal(() => assertAddressesStable(moved, deriveAddresses(parent.children)), "address_drift");
    refusal(() => assertAddressesStable(parent.addresses.slice(1), deriveAddresses(parent.children)), "address_drift");
    const respec = parent.addresses.map((entry, index) => (index === 1 ? { ...entry, specDigest: "5".repeat(64) } : entry));
    refusal(() => assertAddressesStable(respec, deriveAddresses(parent.children)), "address_drift");
  });

  it("two children can never claim the same stable address", () => {
    const parent = plan();
    const clash = structuredClone(parent.children);
    (clash[1] as { nodes: unknown }).nodes = clash[0].nodes;
    (clash[1] as { authority: unknown }).authority = clash[0].authority;
    refusal(() => deriveAddresses(clash), "address_drift");
  });
});

describe("replacing the cross-provider refusal only on proof (MIX-01)", () => {
  const noDrivers = () => undefined;
  const multiProvider = (problems: string[]) => problems.filter((problem) => problem.includes("multi-provider graphs are not executable yet"));

  it("still refuses foreign placements for every caller without an admission", () => {
    const graph = mixedGraph();
    expect(multiProvider(findGraphProblems(graph, "aws", noDrivers))).toHaveLength(2);
    expect(multiProvider(findGraphProblems(graph, "gcp", noDrivers))).toHaveLength(2);
  });

  it("lifts the refusal for exactly the admitted addresses once every partition is bound and verified", () => {
    const parent = plan();
    const graph = mixedGraph();
    const admission = admitMixedGraph({ plan: parent, graph, connections: connectionMap(parent) });
    expect(isMixedAdmission(admission)).toBe(true);
    expect([...admission.addresses].sort()).toEqual([DB, FN, WEB].sort());
    expect(multiProvider(findGraphProblems(graph, "aws", noDrivers, admission))).toHaveLength(0);
    // an admission minted for other addresses lifts nothing for this graph
    const partial = { ...admission, addresses: new Set([DB]) };
    expect(isMixedAdmission(partial)).toBe(false);
    expect(multiProvider(findGraphProblems(graph, "aws", noDrivers, partial as typeof admission))).toHaveLength(2);
  });

  it("a structurally identical object is not an admission", () => {
    const graph = mixedGraph();
    const forged = { parentPlanId: "x", graphDigest: graph.graphDigest, addresses: new Set(graph.nodes.map((node) => node.address)) };
    expect(isMixedAdmission(forged)).toBe(false);
    expect(multiProvider(findGraphProblems(graph, "aws", noDrivers, forged))).toHaveLength(2);
  });

  it("is all or nothing: one revoked, missing, foreign or changed connection refuses the whole graph", () => {
    const parent = plan();
    const graph = mixedGraph();
    const base = connectionMap(parent);
    const awsId = parent.children.find((child) => child.authority.provider === "aws")!.authority.connectionId;
    const gcpId = parent.children.find((child) => child.authority.provider === "gcp")!.authority.connectionId;
    refusal(() => admitMixedGraph({ plan: parent, graph, connections: new Map<string, ProviderConnection | null>(base).set(awsId, connection("aws", { id: awsId, status: "revoked" })) }), "connection_unverified");
    refusal(() => admitMixedGraph({ plan: parent, graph, connections: new Map(base).set(awsId, null) }), "connection_unverified");
    refusal(() => admitMixedGraph({ plan: parent, graph, connections: new Map(base).set(gcpId, connection("gcp", { id: gcpId, workspaceId: "other" })) }), "connection_foreign");
    refusal(() => admitMixedGraph({ plan: parent, graph, connections: new Map(base).set(awsId, connection("aws", { id: awsId, deployRole: `arn:aws:iam::${ACCOUNT}:role/rotated` })) }), "plan_refused");
    refusal(() => admitMixedGraph({ plan: parent, graph, connections: new Map(base).set(awsId, connection("aws", { id: awsId, status: "pending_verification" })) }), "connection_unverified");
  });

  it("refuses a graph that changed, belongs elsewhere or has a node no partition covers", () => {
    const parent = plan();
    const connections = connectionMap(parent);
    const changed = mixedGraph(); changed.nodes.find((node) => node.address === DB)!.spec.storageGb = 99; refresh(changed);
    refusal(() => admitMixedGraph({ plan: parent, graph: changed, connections }), "plan_refused");
    const elsewhere = mixedGraph(); (elsewhere as { environmentId: string }).environmentId = "env-elsewhere";
    refusal(() => admitMixedGraph({ plan: parent, graph: elsewhere, connections }), "plan_refused");
    const extra = mixedGraph(); extra.nodes.push({ ...extra.nodes[0], address: "service/extra" }); refresh(extra);
    (parent as { graphDigest: string }).graphDigest = extra.graphDigest;
    refusal(() => admitMixedGraph({ plan: parent, graph: extra, connections }), "unbound_partition");
  });
});

describe("a child environment deploys exactly its approved subplan", () => {
  it("accepts the same resources and refuses extra, changed, moved or missing ones", () => {
    const parent = plan();
    const aws = parent.children.find((child) => child.authority.provider === "aws")!;
    const own = mixedGraph().nodes.filter((node) => node.provider === "aws");
    expect(() => verifyChildGraph(aws, { nodes: own })).not.toThrow();
    refusal(() => verifyChildGraph(aws, { nodes: [...own, { ...own[0], address: "service/unapproved" }] }), "child_mismatch");
    refusal(() => verifyChildGraph(aws, { nodes: [{ ...own[0], specDigest: "6".repeat(64) }] }), "child_mismatch");
    refusal(() => verifyChildGraph(aws, { nodes: [{ ...own[0], region: "us-west-2" }] }), "child_mismatch");
    refusal(() => verifyChildGraph(aws, { nodes: [{ ...own[0], provider: "gcp" }] }), "child_mismatch");
    refusal(() => verifyChildGraph(aws, { nodes: [] }), "child_mismatch");
    refusal(() => verifyChildGraph(aws, { nodes: [own[0], own[0]] }), "child_mismatch");
  });
});

describe("a child's authority is re-proved against the stored connection", () => {
  const parent = plan();
  const gcp = parent.children.find((child) => child.authority.provider === "gcp")!;
  const input = (conn: ReturnType<typeof connection> | null) => ({ workspaceId: WS, parentEnvironmentId: PARENT_ENV, child: gcp, connection: conn });

  it("passes for the unchanged connection", () => {
    expect(() => reverifyAuthority(input(connection("gcp", { id: gcp.authority.connectionId })))).not.toThrow();
  });

  it("refuses a missing, revoked, unverified, foreign or different connection", () => {
    refusal(() => reverifyAuthority(input(null)), "connection_unverified");
    refusal(() => reverifyAuthority(input(connection("gcp", { id: gcp.authority.connectionId, status: "revoked" }))), "connection_unverified");
    refusal(() => reverifyAuthority(input(connection("gcp", { id: gcp.authority.connectionId, status: "failed" }))), "connection_unverified");
    refusal(() => reverifyAuthority(input(connection("gcp", { id: gcp.authority.connectionId, workspaceId: "other" }))), "connection_foreign");
    refusal(() => reverifyAuthority(input(connection("gcp", { id: "conn-gcp-different" }))), "plan_refused");
  });

  it("refuses an identity that changed after approval (a different state backend)", () => {
    const changed = connection("gcp", { id: gcp.authority.connectionId });
    if (changed.config.provider === "gcp") changed.config.stateBucket = "zenith-mix-gcp-other";
    refusal(() => reverifyAuthority(input(changed)), "plan_refused");
  });
});

describe("durable receipts", () => {
  const base = { workspaceId: WS, parentPlanId: "mpp_x", partitionId: "partition/abc", ordinal: 1, childOperationId: "op_1", outcome: "succeeded" as const, childStatus: "succeeded", executableSemanticsDigest: "7".repeat(64), planDigest: "8".repeat(64) };

  it("are content-addressed: the same outcome is the same receipt and a different one is not", () => {
    const a = buildReceipt(base, "2026-10-07T00:00:00.000Z");
    const b = buildReceipt(base, "2026-10-08T00:00:00.000Z");
    expect(a.receiptDigest).toBe(b.receiptDigest);
    expect(a.receiptId).toBe(b.receiptId);
    expect(receiptDigestOf({ ...base, outcome: "uncertain" })).not.toBe(a.receiptDigest);
    expect(receiptDigestOf({ ...base, childOperationId: "op_2" })).not.toBe(a.receiptDigest);
    expect(JSON.stringify(a)).not.toMatch(/token|secret|password/i);
  });

  it("map operation statuses to outcomes and leave non-terminal ones unmapped", () => {
    expect(outcomeOfOperationStatus("succeeded")).toBe("succeeded");
    for (const status of ["failed", "denied", "rejected", "expired"]) expect(outcomeOfOperationStatus(status)).toBe("failed");
    expect(outcomeOfOperationStatus("uncertain")).toBe("uncertain");
    expect(outcomeOfOperationStatus("cancelled")).toBe("cancelled");
    for (const status of ["running", "approved", "awaiting_approval", "queued", "proposed"]) expect(outcomeOfOperationStatus(status)).toBeUndefined();
  });
});

describe("fixtures", () => {
  it("use the production partition planner and the workspace project ids they claim", () => {
    const parent = plan();
    expect(parent.workspaceId).toBe(WS);
    expect(parent.projectId).toBe(PROJECT);
    expect(parent.parentEnvironmentId).toBe(PARENT_ENV);
    expect(buildParentPlan).toBeTypeOf("function");
  });
});
