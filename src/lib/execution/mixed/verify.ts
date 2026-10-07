/**
 * Pure re-verification of a stored plan against current facts (PROD-MIX-01 / 02).
 * Run before a child is adopted, before the parent starts and again before every
 * child starts. Each check is a refusal: nothing is repaired, re-mapped or
 * compensated, and a difference means the approved plan no longer describes what
 * would run.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import { bindingIdentity, MixedPartitionError } from "@/lib/execution/mixed-partitions";
import type { ResourceGraph } from "@/lib/resources/types";
import { assertConnectionAuthorized, bindingFor } from "./partitioner";
import { MixedPlanError, type ChildSubplan } from "./types";

/**
 * The child environment's own graph must be an exact subset of its partition: every node it would apply is a node the
 * parent approved (same kind, provider, region, native type, ownership and spec digest), and every managed node the parent
 * approved for this partition is present. A node missing or extra on either side is a mismatch, never an approximation.
 */
export function verifyChildGraph(child: Pick<ChildSubplan, "partitionId" | "nodes" | "authority">, graph: Pick<ResourceGraph, "nodes">): void {
  const approved = new Map(child.nodes.map((node) => [node.address, node]));
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    const expected = approved.get(node.address);
    if (!expected || seen.has(node.address)) throw new MixedPlanError("child_mismatch", "The child environment would apply a resource the parent plan did not approve for it.", { partitionId: child.partitionId });
    seen.add(node.address);
    if (expected.specDigest !== node.specDigest || expected.kind !== node.kind || expected.nativeType !== node.nativeType || expected.ownership !== node.ownership
      || node.provider !== child.authority.provider || node.region !== child.authority.region) {
      throw new MixedPlanError("child_mismatch", "A resource in the child environment differs from the approved subplan.", { partitionId: child.partitionId });
    }
  }
  for (const node of child.nodes) {
    if (node.ownership === "managed" && !seen.has(node.address)) {
      throw new MixedPlanError("child_mismatch", "A managed resource of the approved subplan is missing from the child environment.", { partitionId: child.partitionId });
    }
  }
}

/**
 * The connection must still be this workspace's, verified and unrevoked, and still describe the same account, region,
 * identity selectors and state backend the approval pinned. A rotated or edited connection needs a new plan.
 */
export function reverifyAuthority(input: { workspaceId: string; parentEnvironmentId: string; child: Pick<ChildSubplan, "partitionId" | "childEnvironmentId" | "authority">; connection: ProviderConnection | null }): void {
  const { child, connection } = input;
  if (!connection) throw new MixedPlanError("connection_unverified", "A child's connection no longer resolves.", { partitionId: child.partitionId });
  assertConnectionAuthorized(connection, input.workspaceId);
  if (connection.id !== child.authority.connectionId) throw new MixedPlanError("plan_refused", "The child's environment now uses a different connection than the approved plan.", { partitionId: child.partitionId });
  const binding = bindingFor({ childEnvironmentId: child.childEnvironmentId, connection }, input.workspaceId);
  let identity: ReturnType<typeof bindingIdentity>;
  try {
    identity = bindingIdentity(binding, input.workspaceId, input.parentEnvironmentId);
  } catch (error) {
    if (error instanceof MixedPartitionError) throw new MixedPlanError("plan_refused", error.message, { partitionId: child.partitionId, code: error.code });
    throw error;
  }
  const a = child.authority;
  if (identity.connectionIdentityDigest !== a.connectionIdentityDigest || identity.backendDigest !== a.backendDigest || identity.stateLocationDigest !== a.stateLocationDigest
    || identity.accountId !== a.accountId || identity.region !== a.region || identity.provider !== a.provider) {
    throw new MixedPlanError("plan_refused", "A child's connection or state backend changed after the plan was approved; plan again.", { partitionId: child.partitionId });
  }
}
