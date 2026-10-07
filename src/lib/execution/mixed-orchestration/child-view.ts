/**
 * The narrow interface between mixed-graph planning (partitions, immutable child
 * plans: PROD-MIX-01/02) and this orchestration layer.
 *
 * Everything here reads a `ParentPlanView`: ids, digests, dependency edges, node
 * ownership and the typed reference contracts. `parentViewOf` is the single join:
 * it derives the view from a `MixedPartitionPlan` that `planMixedPartitions`
 * produced. If the partition/subplan model changes shape, only this adapter changes;
 * the output, failure and teardown modules never import the planner.
 */
import type { MixedPartitionPlan, PartitionReference, PartitionValueType } from "../mixed-partitions";
import { digest } from "@/lib/controlplane/digest";
import { cmp, ID, refuse, SHA } from "./errors";

export type NodeOwnership = "managed" | "referenced" | "external";

export interface ChildNodeView {
  readonly address: string;
  readonly ownership: NodeOwnership;
  readonly kind: string;
}

export interface ChildPlanView {
  /** Stable partition id of the child. */
  readonly id: string;
  readonly connectionId: string;
  readonly provider: string;
  /** Digest of the immutable subplan (desired inputs only). */
  readonly subplanDigest: string;
  /** Digest of the exact incoming materialization the reviewer approved. */
  readonly effectDigest: string;
  /** Child ids this child depends on (consumer -> producer). */
  readonly dependsOn: readonly string[];
  readonly nodes: readonly ChildNodeView[];
}

export interface ReferenceView {
  readonly id: string;
  readonly producerChildId: string;
  readonly consumerChildId: string;
  readonly producerAddress: string;
  readonly producerOutput: string;
  readonly consumerAddress: string;
  readonly consumerInput: string;
  readonly type: PartitionValueType;
  readonly contractDigest: string;
  /** True when the plan already holds an available materialization (otherwise the consumer cannot start yet). */
  readonly materialized: boolean;
}

export interface ParentPlanView {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly desiredDigest: string;
  readonly parentDigest: string;
  readonly children: readonly ChildPlanView[];
  readonly references: readonly ReferenceView[];
}

/**
 * `plan` must come from `planMixedPartitions`; `references` is the same reference
 * inventory that was planned. Every planned reference must be found with a matching
 * contract digest, so an address or output name cannot be substituted here.
 */
export function parentViewOf(plan: MixedPartitionPlan, references: readonly PartitionReference[]): ParentPlanView {
  const partitionOf = new Map<string, string>();
  for (const partition of plan.partitions) for (const node of partition.nodes) partitionOf.set(node.address, partition.id);
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const views: ReferenceView[] = [];
  for (const planned of plan.references) {
    const reference = byId.get(planned.id);
    if (!reference) return refuse("contract_mismatch", planned.id);
    const contract = digest({ id: reference.id, scope: reference.scope, producer: reference.producer, consumer: reference.consumer });
    const producerChildId = partitionOf.get(reference.producer.address);
    const consumerChildId = partitionOf.get(reference.consumer.address);
    if (!producerChildId || !consumerChildId || contract !== planned.contractDigest || producerChildId !== planned.producerPartitionId || consumerChildId !== planned.consumerPartitionId) return refuse("contract_mismatch", planned.id);
    views.push({ id: reference.id, producerChildId, consumerChildId, producerAddress: reference.producer.address, producerOutput: reference.producer.output,
      consumerAddress: reference.consumer.address, consumerInput: reference.consumer.input, type: reference.producer.type, contractDigest: contract,
      materialized: planned.state === "available" });
  }
  const view: ParentPlanView = {
    workspaceId: plan.workspaceId, environmentId: plan.environmentId, desiredDigest: plan.desiredDigest, parentDigest: plan.parentDigest,
    children: plan.partitions.map((partition) => ({
      id: partition.id, connectionId: partition.identity.connectionId, provider: partition.identity.provider,
      subplanDigest: partition.subplanDigest, effectDigest: partition.effectDigest, dependsOn: [...partition.dependsOn],
      nodes: partition.nodes.map((node) => ({ address: node.address, ownership: node.ownership, kind: node.kind })),
    })).sort((a, b) => cmp(a.id, b.id)),
    references: views.sort((a, b) => cmp(a.id, b.id)),
  };
  assertParentView(view);
  return Object.freeze(view);
}

/** Structural validation of a view (also used for views assembled by tests or a later planner). */
export function assertParentView(view: ParentPlanView): void {
  if (!ID.test(view.workspaceId) || !ID.test(view.environmentId) || !SHA.test(view.desiredDigest) || !SHA.test(view.parentDigest) || !view.children.length) refuse("invalid_input");
  const ids = new Set<string>();
  for (const child of view.children) {
    if (!child.id || ids.has(child.id) || !SHA.test(child.subplanDigest) || !SHA.test(child.effectDigest) || !ID.test(child.connectionId)) refuse("invalid_input");
    ids.add(child.id);
  }
  for (const child of view.children) {
    for (const dependency of child.dependsOn) {
      if (!ids.has(dependency)) refuse("unknown_child", dependency);
      if (dependency === child.id) refuse("dependency_cycle", child.id);
    }
  }
  const refIds = new Set<string>();
  for (const reference of view.references) {
    if (refIds.has(reference.id) || !ids.has(reference.producerChildId) || !ids.has(reference.consumerChildId) || reference.producerChildId === reference.consumerChildId || !SHA.test(reference.contractDigest)) refuse("contract_mismatch", reference.id);
    refIds.add(reference.id);
  }
}
