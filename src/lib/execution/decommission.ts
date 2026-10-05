/**
 * The ownership-safe decommission gate, called from every path that can delete
 * managed data: the deploy plan inspector (a plan that deletes or replaces) and
 * the teardown review and apply (`execution/destroy.ts`).
 *
 * Existing guards still decide everything they decided before (managed only,
 * explicit `deletionPolicy` for stateful resources, a human, digest-bound
 * approval). This adds the adoption rule from `@/lib/portability/decommission`:
 * an object Zenith adopted rather than created is never deleted unless the human
 * who claimed it allowed destruction, and a released or mismatched claim is a
 * refusal. The refusal is a `StepFailedError` raised BEFORE any deletion.
 *
 * The adoption facts come from the tenant-scoped store through
 * `ExecutionDeps.portability`. A worker without that port (test fakes) has no
 * adoption facts and the rule is vacuous; the production composition always
 * supplies it.
 */
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { ResourceNode } from "@/lib/resources/types";
import { DecommissionRefusedError, assertDecommissionAllowed, type DecommissionTarget } from "@/lib/portability/decommission";
import type { ExecContext } from "./context";
import { StepFailedError } from "./errors";
import type { Runtime } from "./runtime";

const targetOf = (n: ResourceNode): DecommissionTarget => ({ address: n.address, kind: n.kind, ownership: n.ownership, ...(n.externalRef ? { externalId: n.externalRef } : {}) });

async function enforce(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "environmentId">, nodes: readonly ResourceNode[]): Promise<void> {
  if (nodes.length === 0 || !rt.d.portability) return;
  const adoptions = await rt.d.portability.adoptionFacts(ec.workspaceId, ec.environmentId);
  if (adoptions.length === 0) return;
  try {
    assertDecommissionAllowed(nodes.map(targetOf), adoptions);
  } catch (err) {
    if (err instanceof DecommissionRefusedError) throw new StepFailedError(`Refusing to delete: ${err.message}`);
    throw err;
  }
}

/** Teardown deletes every managed node of the environment. */
export async function assertTeardownOwnership(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "environmentId">, nodes: readonly ResourceNode[]): Promise<void> {
  await enforce(rt, ec, nodes.filter((n) => n.ownership === "managed"));
}

/** A deploy plan deletes or replaces only what its changes name. */
export async function assertPlanDeletionsOwned(rt: Runtime, ec: Pick<ExecContext, "workspaceId" | "environmentId">, plan: NormalizedPlan, nodes: readonly ResourceNode[]): Promise<void> {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const doomed = new Map<string, ResourceNode>();
  for (const change of plan.resourceChanges) {
    if (change.action !== "delete" && change.action !== "replace") continue;
    const node = byAddress.get(change.nodeAddress ?? change.address);
    if (node && node.ownership === "managed") doomed.set(node.address, node);
  }
  await enforce(rt, ec, [...doomed.values()]);
}
