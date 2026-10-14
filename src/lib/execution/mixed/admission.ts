/**
 * Replacing the cross-provider refusal, and only on proof (PROD-MIX-01).
 *
 * Admission binds a complete, unchanged graph to verified child connections.
 * The consumer rechecks the binding; token identity alone is not sufficient.
 * This grants no authority to act: children retain their own approval and
 * credential guards. No cloud calls or mutable caller data are stored here.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import { cmp, graphDigestOf, specDigestOf } from "@/lib/resources/expand-support";
import type { ResourceGraph } from "@/lib/resources/types";
import { assertAddressesStable, deriveAddresses } from "./addresses";
import { assertParentPlanIntegrity } from "./parent-plan";
import { MixedPlanError, type MixedParentPlan } from "./types";
import { reverifyAuthority } from "./verify";

export interface MixedAdmission {
  readonly parentPlanId: string;
  readonly graphDigest: string;
  /** Diagnostic snapshot only. Mutating a returned Set cannot change admission. */
  readonly addresses: ReadonlySet<string>;
}

type AdmissionGraph = Pick<ResourceGraph, "nodes" | "edges" | "graphDigest" | "environmentId">;
type Binding = Readonly<{ environmentId: string; graphDigest: string }>;
const minted = new WeakMap<object, Binding>();

/** Token provenance only; consumers must also call isMixedAdmissionForGraph. */
export function isMixedAdmission(value: unknown): value is MixedAdmission {
  return !!value && typeof value === "object" && minted.has(value);
}

/** Recompute content, not just caller-maintained digest fields. Do not mutate the graph. */
function checkedGraphDigest(graph: AdmissionGraph): string {
  const nodes = [...graph.nodes].sort((a, b) => cmp(a.address, b.address));
  if (new Set(nodes.map((node) => node.address)).size !== nodes.length) {
    throw new MixedPlanError("unbound_partition", "The graph contains duplicate resource addresses.");
  }
  for (const node of nodes) {
    if (specDigestOf(node) !== node.specDigest) throw new MixedPlanError("plan_refused", "A graph node changed without updating its reviewed digest.");
  }
  const edgeKey = (edge: AdmissionGraph["edges"][number]) => `${edge.from}\0${edge.to}\0${edge.relation}\0${edge.detail ?? ""}`;
  const edges = [...graph.edges].sort((a, b) => cmp(edgeKey(a), edgeKey(b)));
  const fresh = graphDigestOf(nodes, edges);
  if (fresh !== graph.graphDigest) throw new MixedPlanError("plan_refused", "The graph content does not match its reviewed digest.");
  return fresh;
}

/** Evaluate once per graph consumption, rather than rehashing for every node. */
export function isMixedAdmissionForGraph(value: unknown, graph: AdmissionGraph): value is MixedAdmission {
  if (!isMixedAdmission(value)) return false;
  const binding = minted.get(value)!;
  if (graph.environmentId !== binding.environmentId || graph.graphDigest !== binding.graphDigest) return false;
  try { return checkedGraphDigest(graph) === binding.graphDigest; }
  catch { return false; }
}

export function admitMixedGraph(input: {
  plan: MixedParentPlan;
  graph: AdmissionGraph;
  /** Current platform connections by id; null means a connection no longer resolves. */
  connections: ReadonlyMap<string, ProviderConnection | null>;
}): MixedAdmission {
  const { plan, graph } = input;
  assertParentPlanIntegrity(plan);
  if (graph.graphDigest !== plan.graphDigest) throw new MixedPlanError("plan_refused", "The graph changed after the parent plan was made; plan again.");
  if (graph.environmentId !== plan.parentEnvironmentId) throw new MixedPlanError("plan_refused", "The graph belongs to another environment than the parent plan.");
  const declared = plan.children.flatMap((child) => child.nodes.map((node) => [node.address, node.specDigest] as const));
  const covered = new Map(declared);
  if (covered.size !== declared.length) throw new MixedPlanError("unbound_partition", "The parent plan contains duplicate resource addresses.");
  for (const node of graph.nodes) {
    if (covered.get(node.address) !== node.specDigest) {
      throw new MixedPlanError("unbound_partition", "A graph node is not covered by a partition of the parent plan.", { address: node.address });
    }
  }
  if (covered.size !== graph.nodes.length) throw new MixedPlanError("plan_refused", "The parent plan covers nodes that are not in the graph.");
  const graphDigest = checkedGraphDigest(graph);
  for (const child of plan.children) {
    reverifyAuthority({ workspaceId: plan.workspaceId, parentEnvironmentId: plan.parentEnvironmentId, child, connection: input.connections.get(child.authority.connectionId) ?? null });
  }
  assertAddressesStable(plan.addresses, deriveAddresses(plan.children));
  const addresses = [...covered.keys()];
  const admission: MixedAdmission = Object.freeze({
    parentPlanId: plan.parentPlanId,
    graphDigest,
    get addresses(): ReadonlySet<string> { return new Set(addresses); },
  });
  minted.set(admission, Object.freeze({ environmentId: graph.environmentId, graphDigest }));
  return admission;
}
