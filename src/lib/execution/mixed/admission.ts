/**
 * Replacing the cross-provider refusal, and only on proof (PROD-MIX-01).
 *
 * `findGraphProblems` refuses a node placed on a provider other than its
 * environment's. That refusal is lifted for a node only when the caller holds a
 * `MixedAdmission`, which this module mints solely after checking, against the
 * stored parent plan and current facts, that EVERY node of the graph belongs to a
 * partition whose connection is bound, verified, unrevoked and unchanged since
 * approval. There is no partial admission: one unbound or unverified partition
 * refuses the whole graph, and the original refusal text stays for every caller
 * that cannot present an admission.
 *
 * An admission grants no authority to act. It only lets graph validation proceed
 * to the ordinary per-node checks (driver, externalRef, ownership). Execution
 * still goes child by child through each child's own approvals and guards.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import type { ResourceGraph } from "@/lib/resources/types";
import { assertAddressesStable, deriveAddresses } from "./addresses";
import { assertParentPlanIntegrity } from "./parent-plan";
import { MixedPlanError, type MixedParentPlan } from "./types";
import { reverifyAuthority } from "./verify";

export interface MixedAdmission {
  readonly parentPlanId: string;
  readonly graphDigest: string;
  /** Addresses whose foreign placement is explained by a bound, verified partition. */
  readonly addresses: ReadonlySet<string>;
}

const minted = new WeakSet<object>();

/** Only a value minted by `admitMixedGraph` is an admission; a structurally similar object is not. */
export function isMixedAdmission(value: unknown): value is MixedAdmission {
  return !!value && typeof value === "object" && minted.has(value);
}

export function admitMixedGraph(input: {
  plan: MixedParentPlan;
  graph: Pick<ResourceGraph, "nodes" | "graphDigest" | "environmentId">;
  /** Current platform connections by id, as loaded from the store right now. `null` means it no longer resolves. */
  connections: ReadonlyMap<string, ProviderConnection | null>;
}): MixedAdmission {
  const { plan, graph } = input;
  assertParentPlanIntegrity(plan);
  if (graph.graphDigest !== plan.graphDigest) throw new MixedPlanError("plan_refused", "The graph changed after the parent plan was made; plan again.");
  if (graph.environmentId !== plan.parentEnvironmentId) throw new MixedPlanError("plan_refused", "The graph belongs to another environment than the parent plan.");
  const covered = new Map(plan.children.flatMap((child) => child.nodes.map((node) => [node.address, node.specDigest] as const)));
  for (const node of graph.nodes) {
    if (covered.get(node.address) !== node.specDigest) {
      throw new MixedPlanError("unbound_partition", "A graph node is not covered by a partition of the parent plan.", { address: node.address });
    }
  }
  if (covered.size !== graph.nodes.length) throw new MixedPlanError("plan_refused", "The parent plan covers nodes that are not in the graph.");
  for (const child of plan.children) {
    reverifyAuthority({ workspaceId: plan.workspaceId, parentEnvironmentId: plan.parentEnvironmentId, child, connection: input.connections.get(child.authority.connectionId) ?? null });
  }
  assertAddressesStable(plan.addresses, deriveAddresses(plan.children));
  const admission: MixedAdmission = Object.freeze({ parentPlanId: plan.parentPlanId, graphDigest: plan.graphDigest, addresses: new Set(covered.keys()) as ReadonlySet<string> });
  minted.add(admission);
  return admission;
}
