/**
 * The parent plan: an ordered set of immutable child subplans (PROD-MIX-02).
 *
 * `buildParentPlan` runs the existing pure partition planner
 * (`planMixedPartitions`, which validates graph integrity, account/region/backend
 * identity, state-object disjointness, typed references and dependency cycles)
 * and re-expresses its result in the persisted `MixedParentPlan` document:
 *
 *  - each child carries its own semantics digest, `childSemanticsDigest`: the
 *    digest the parent approval pins for it (subplan + the connection identity
 *    and state backend it may use). It does NOT include dependency outputs, which
 *    are unknown until producers run; materialization is pinned separately by
 *    `effectDigest` and a change in it needs a new review (MIX-03).
 *  - `childSetDigest` is the digest of the ordered child set. The parent
 *    operation's immutable proposal input carries it, so a human approval of that
 *    operation is an approval of exactly this set.
 *  - nothing here grants authority or starts anything.
 */
import { digest } from "@/lib/controlplane/digest";
import {
  MixedPartitionError, planMixedPartitions, type MixedPartitionPlan, type PartitionReference, type PlannedPartition,
} from "@/lib/execution/mixed-partitions";
import type { ResourceGraph } from "@/lib/resources/types";
import { deriveAddresses, stableAddress } from "./addresses";
import { assignPartitions, type ChildEnvironmentCandidate, type PartitionPin } from "./partitioner";
import {
  MIXED_CHILD_SEMANTICS_FORMAT, MIXED_CHILD_SET_FORMAT, MIXED_PARENT_INPUT_KEY, MIXED_PARENT_PLAN_FORMAT, MixedPlanError,
  type ChildNode, type ChildReference, type ChildSubplan, type MixedParentPlan, type MixedParentProposalInput,
} from "./types";

/** A declared cross-partition value. Materialization is always "not produced yet" at planning time. */
export interface DeclaredReference {
  id: string;
  producer: { address: string; output: string; type: PartitionReference["producer"]["type"] };
  consumer: { address: string; input: string; type: PartitionReference["consumer"]["type"] };
}

export interface BuildParentPlanInput {
  workspaceId: string;
  projectId: string;
  parentEnvironmentId: string;
  graph: ResourceGraph;
  candidates: readonly ChildEnvironmentCandidate[];
  pins?: readonly PartitionPin[];
  references?: readonly DeclaredReference[];
}

/** The digest the parent approval pins for one child. */
export function childSemanticsDigest(child: Pick<ChildSubplan, "partitionId" | "childEnvironmentId" | "subplanDigest" | "authority">): string {
  return digest({
    format: MIXED_CHILD_SEMANTICS_FORMAT, partitionId: child.partitionId, childEnvironmentId: child.childEnvironmentId, subplanDigest: child.subplanDigest,
    connectionIdentityDigest: child.authority.connectionIdentityDigest, backendDigest: child.authority.backendDigest, stateLocationDigest: child.authority.stateLocationDigest,
  });
}

export function childSetDigest(children: readonly Pick<ChildSubplan, "partitionId" | "ordinal" | "childEnvironmentId" | "subplanDigest" | "semanticsDigest">[], executionOrder: readonly string[]): string {
  return digest({
    format: MIXED_CHILD_SET_FORMAT, executionOrder,
    children: children.map((c) => ({ partitionId: c.partitionId, ordinal: c.ordinal, childEnvironmentId: c.childEnvironmentId, subplanDigest: c.subplanDigest, semanticsDigest: c.semanticsDigest })),
  });
}

export function parentPlanIdFor(workspaceId: string, parentEnvironmentId: string, parentDigest: string): string {
  return `mpp_${digest({ workspaceId, parentEnvironmentId, parentDigest }).slice(0, 32)}`;
}

function toChild(partition: PlannedPartition, ordinal: number, childEnvironmentId: string): ChildSubplan {
  const identity = partition.identity;
  const authority = {
    bindingId: identity.bindingId, connectionId: identity.connectionId, provider: identity.provider, accountId: identity.accountId, region: identity.region,
    connectionIdentityDigest: identity.connectionIdentityDigest, backendKind: identity.backendKind, backendDigest: identity.backendDigest,
    stateLocationDigest: identity.stateLocationDigest, stateEnvironmentId: childEnvironmentId,
  };
  const inside = new Set(partition.nodes.map((node) => node.address));
  const nodes: ChildNode[] = partition.nodes.map((node) => ({
    stableAddress: stableAddress(authority, node.address), address: node.address, kind: node.kind, nativeType: node.nativeType, ownership: node.ownership,
    specDigest: node.specDigest, dependsOn: node.dependsOn.filter((address) => inside.has(address)),
  }));
  const partial = { partitionId: partition.id, childEnvironmentId, subplanDigest: partition.subplanDigest, authority };
  return {
    partitionId: partition.id, ordinal, childEnvironmentId, dependsOn: partition.dependsOn, authority, nodes,
    subplanDigest: partition.subplanDigest, effectDigest: partition.effectDigest, semanticsDigest: childSemanticsDigest(partial),
    blockedByReferences: partition.blockedByReferences,
  };
}

/** Pure. Refusals from the planner are re-thrown as `MixedPlanError("plan_refused")` carrying only its fixed code. */
export function buildParentPlan(input: BuildParentPlanInput): MixedParentPlan {
  const { workspaceId, graph } = input;
  const assigned = assignPartitions({ workspaceId, graph, candidates: input.candidates, pins: input.pins });
  const references: PartitionReference[] = (input.references ?? []).map((ref) => ({
    id: ref.id, scope: { workspaceId, environmentId: graph.environmentId }, producer: ref.producer, consumer: ref.consumer,
    materialization: { state: "unavailable", reason: "not_produced" },
  }));
  let plan: MixedPartitionPlan;
  try {
    plan = planMixedPartitions({ workspaceId, graph, bindings: assigned.bindings, assignments: assigned.assignments, references });
  } catch (error) {
    if (error instanceof MixedPartitionError) throw new MixedPlanError("plan_refused", error.message, { code: error.code });
    throw error;
  }
  const byId = new Map(plan.partitions.map((partition) => [partition.id, partition]));
  const children = plan.executionOrder.map((id, ordinal) => {
    const partition = byId.get(id)!;
    const childEnvironmentId = assigned.childEnvironmentOf.get(partition.identity.bindingId);
    if (!childEnvironmentId) throw new MixedPlanError("child_mismatch", "A partition has no child environment.");
    return toChild(partition, ordinal, childEnvironmentId);
  });
  const declared = new Map((input.references ?? []).map((ref) => [ref.id, ref]));
  const refs: ChildReference[] = plan.references.map((ref) => {
    const contract = declared.get(ref.id);
    return {
      referenceId: ref.id, producerPartitionId: ref.producerPartitionId, consumerPartitionId: ref.consumerPartitionId,
      contractDigest: ref.contractDigest, materializationDigest: ref.materializationDigest, state: ref.state,
      ...(ref.unavailableReason ? { unavailableReason: ref.unavailableReason } : {}),
      ...(contract ? { producerAddress: contract.producer.address, producerOutput: contract.producer.output, consumerAddress: contract.consumer.address, consumerInput: contract.consumer.input, valueType: contract.producer.type } : {}),
    };
  });
  const set = childSetDigest(children, plan.executionOrder);
  return {
    format: MIXED_PARENT_PLAN_FORMAT,
    parentPlanId: parentPlanIdFor(workspaceId, input.parentEnvironmentId, plan.parentDigest),
    workspaceId, projectId: input.projectId, parentEnvironmentId: input.parentEnvironmentId,
    manifestDigest: plan.manifestDigest, graphDigest: plan.graphDigest, desiredDigest: plan.desiredDigest, parentDigest: plan.parentDigest, childSetDigest: set,
    children, references: refs, executionOrder: plan.executionOrder, teardownOrder: plan.teardownOrder, addresses: deriveAddresses(children),
  };
}

/** Recompute every digest from the document itself. Stored plans are re-checked with this before any child starts. */
export function assertParentPlanIntegrity(plan: MixedParentPlan): void {
  if (plan.format !== MIXED_PARENT_PLAN_FORMAT) throw new MixedPlanError("plan_refused", "The parent plan has an unknown format.");
  const ordered = [...plan.children].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.some((child, index) => child.ordinal !== index) || plan.executionOrder.join("|") !== ordered.map((c) => c.partitionId).join("|")) {
    throw new MixedPlanError("plan_refused", "The parent plan's execution order does not match its children.");
  }
  const known = new Set(plan.executionOrder);
  for (const child of ordered) {
    if (childSemanticsDigest(child) !== child.semanticsDigest) throw new MixedPlanError("plan_refused", "A child's semantics digest does not match its subplan.", { partitionId: child.partitionId });
    for (const dependency of child.dependsOn) {
      const dep = ordered.find((c) => c.partitionId === dependency);
      if (!known.has(dependency) || !dep || dep.ordinal >= child.ordinal) throw new MixedPlanError("plan_refused", "A child depends on a child that does not run before it.", { partitionId: child.partitionId });
    }
  }
  if (childSetDigest(ordered, plan.executionOrder) !== plan.childSetDigest) throw new MixedPlanError("plan_refused", "The child set digest does not match the children.");
  if (plan.teardownOrder.join("|") !== [...plan.executionOrder].reverse().join("|")) throw new MixedPlanError("plan_refused", "The teardown order is not the reverse of the execution order.");
  const fresh = deriveAddresses(ordered);
  if (fresh.length !== plan.addresses.length) throw new MixedPlanError("address_drift", "The parent plan's address registry does not match its children.");
}

/** The immutable input the parent operation carries. A human approves exactly this value. */
export function parentProposalInput(plan: MixedParentPlan): MixedParentProposalInput {
  return {
    [MIXED_PARENT_INPUT_KEY]: plan.parentPlanId, parentDigest: plan.parentDigest, childSetDigest: plan.childSetDigest,
    children: [...plan.children].sort((a, b) => a.ordinal - b.ordinal).map((child) => ({
      partitionId: child.partitionId, ordinal: child.ordinal, childEnvironmentId: child.childEnvironmentId, subplanDigest: child.subplanDigest,
      semanticsDigest: child.semanticsDigest, connectionIdentityDigest: child.authority.connectionIdentityDigest, backendDigest: child.authority.backendDigest,
    })),
  };
}

/** True only when `operationInput` is exactly the proposal input of `plan`: same plan id, parent digest, child set and every child digest. */
export function proposalMatchesPlan(operationInput: unknown, plan: MixedParentPlan): boolean {
  if (!operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) return false;
  return digest(operationInput) === digest(parentProposalInput(plan));
}

