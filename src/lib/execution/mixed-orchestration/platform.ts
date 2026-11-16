/**
 * Production composition of the mixed run service over the platform store and the capability broker
 * (PROD-MIX-03/04). Everything is tenant-scoped; nothing here calls a cloud API.
 */
import type { Broker } from "@/lib/capabilities/platform";
import type { Sql } from "@/lib/controlplane/types";
import * as mixedPlansRepo from "@/lib/controlplane/db/repos/mixed-parent-plans";
import * as preauthRepo from "@/lib/controlplane/db/repos/mixed-output-preauthorizations";
import * as resourceRepo from "@/lib/controlplane/db/repos/resources";
import * as runRepo from "@/lib/controlplane/db/repos/mixed-runs";
import type { MixedParentPlan } from "@/lib/execution/mixed/types";
import { refuse } from "./errors";
import type { PreauthorizationStore } from "./preauthorization";
import { mapStoreError, platformMixedRunStore, storedRunOf } from "./run-store";
import type { MixedRunState } from "./run";
import type { ParentReviewPort, MixedRunDeps } from "./service";
import { brokerTeardownApprovalPort, teardownReleaseGate, type TeardownPlanInput, type TeardownReleaseGate } from "./teardown";

export function platformPreauthorizationStore(sql: Sql): PreauthorizationStore {
  return {
    create: (input) => preauthRepo.create(sql, input),
    get: (workspaceId, id) => preauthRepo.get(sql, workspaceId, id),
    list: (workspaceId, filter) => preauthRepo.list(sql, workspaceId, filter),
    revoke: (input) => preauthRepo.revoke(sql, input),
    reserveUse: (input) => preauthRepo.reserveUse(sql, input),
  };
}

/**
 * Review of a changed parent digest is a person's approval of a review operation the partition executor opened for exactly
 * that digest (`mixedParentReviewOf`, PROD-MIX-01/02 join). The port answers with the parent digest a LIVE, human, non-rejected
 * approval of THIS parent run's review operation covers, bound to that operation's own proposal digest; anything else
 * (an agent, a policy allow, a foreign run, an expired or rejected approval) answers null and nothing is rebound.
 */
export function platformParentReviewPort(sql: Sql): ParentReviewPort {
  return { approvedParentDigest: (workspaceId, parentOperationId, approvalId) => mixedPlansRepo.readReviewApprovalDigest(sql, workspaceId, parentOperationId, approvalId) };
}

/** A port that never confirms a review: for tests and for compositions that have no review path. */
export const refusingParentReviewPort: ParentReviewPort = { approvedParentDigest: async () => null };

export function platformMixedRunDeps(sql: Sql, broker: Broker): MixedRunDeps {
  return {
    runs: platformMixedRunStore(sql),
    preauthorizations: platformPreauthorizationStore(sql),
    roles: broker.deps.roles,
    teardownApprovals: brokerTeardownApprovalPort(broker.deps),
    parentReview: platformParentReviewPort(sql),
    now: () => broker.deps.clock.now(),
  };
}

const LIVE = new Set(["provisioning", "active", "updating", "failed", "unknown", "deleting"]);

/**
 * Each child's own environment, from the stored, digest-bound plan the run was opened from. A child's state and resources
 * live there, not in the parent environment the run is bound to. The plan must be the run's: same workspace, parent
 * environment and desired digest, and every child with the run's subplan digest; anything else refuses.
 */
export function childEnvironmentsOf(plan: MixedParentPlan, state: MixedRunState): ReadonlyMap<string, string> {
  if (plan.workspaceId !== state.workspaceId || plan.parentEnvironmentId !== state.environmentId || plan.desiredDigest !== state.desiredDigest) refuse("stale_digest");
  const environments = new Map<string, string>();
  for (const id of state.order) {
    const child = plan.children.find((candidate) => candidate.partitionId === id);
    if (!child || child.subplanDigest !== state.children[id].subplanDigest) refuse("stale_digest", id);
    environments.set(id, child.childEnvironmentId);
  }
  return environments;
}

/**
 * Ownership and dependents from the resource registry (`platform.resources`) of each child's own environment: an address
 * is attributable to its child only when that environment's registry holds it as `managed` and not deleted/planned;
 * anything referenced, external, missing or not yet created refuses. A registry row of a child environment that is not
 * part of this run and depends on an address counts as an outside dependent. The registry records no per-operation
 * provenance, so this proves "Zenith-managed there", and the run's own receipts prove which child applied it.
 */
export async function platformTeardownPlanInput(sql: Sql, state: MixedRunState, environments: ReadonlyMap<string, string>): Promise<Omit<TeardownPlanInput, "now">> {
  const rowsOf = new Map<string, Awaited<ReturnType<typeof resourceRepo.listByEnvironment>>>();
  for (const environmentId of new Set(environments.values())) rowsOf.set(environmentId, await resourceRepo.listByEnvironment(sql, state.workspaceId, environmentId));
  const inRun = new Set(Object.values(state.children).flatMap((child) => child.nodes.map((node) => node.address)));
  const owners = new Map<string, { parentOperationId: string; childId: string } | null>();
  const environmentOf = new Map<string, string>();
  for (const child of Object.values(state.children)) {
    const environmentId = environments.get(child.id) ?? refuse("stale_digest", child.id);
    for (const node of child.nodes) {
      const row = rowsOf.get(environmentId)!.find((candidate) => candidate.address === node.address);
      owners.set(node.address, row && row.ownership === "managed" && LIVE.has(row.status) ? { parentOperationId: state.parentOperationId, childId: child.id } : null);
      environmentOf.set(node.address, environmentId);
    }
  }
  return {
    owners,
    externalDependents: (address) => (rowsOf.get(environmentOf.get(address) ?? "") ?? []).filter((row) => !inRun.has(row.address) && row.status !== "deleted" && row.dependsOn.includes(address)).map((row) => row.address),
  };
}

/**
 * The teardown release gate of a destroy in `environmentId` (see `teardownReleaseGate`): every run whose stored plan places a
 * child there, read and re-validated. A store that cannot answer, or a malformed run, throws (`unavailable` /
 * `invalid_input`): the destroy then stops before it applies, never treats the environment as not mixed.
 */
export async function teardownReleaseGateOf(sql: Sql, workspaceId: string, environmentId: string, destroyOperationId: string): Promise<TeardownReleaseGate> {
  let rows: Awaited<ReturnType<typeof runRepo.listByChildEnvironment>>;
  try { rows = await runRepo.listByChildEnvironment(sql, workspaceId, environmentId); } catch (error) { return mapStoreError(error); }
  return teardownReleaseGate(rows.map(({ childId, run }) => ({ childId, state: storedRunOf(run).state })), destroyOperationId);
}
