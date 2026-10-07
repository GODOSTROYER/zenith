/**
 * Production composition of the mixed run service over the platform store and the capability broker
 * (PROD-MIX-03/04). Everything is tenant-scoped; nothing here calls a cloud API.
 */
import type { Broker } from "@/lib/capabilities/platform";
import type { Sql } from "@/lib/controlplane/types";
import * as preauthRepo from "@/lib/controlplane/db/repos/mixed-output-preauthorizations";
import * as resourceRepo from "@/lib/controlplane/db/repos/resources";
import type { PreauthorizationStore } from "./preauthorization";
import { platformMixedRunStore } from "./run-store";
import type { MixedRunState } from "./run";
import type { ParentReviewPort, MixedRunDeps } from "./service";
import { brokerTeardownApprovalPort, type TeardownPlanInput } from "./teardown";

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
 * Review of a changed parent digest needs a parent approval round bound to that digest. That round belongs to the
 * parent approval path that joins this work with the partition executor; until it is joined, nothing can claim a
 * review, so a `review_required` decision stays a decision and no consumer is rebound.
 */
export const refusingParentReviewPort: ParentReviewPort = { approvedParentDigest: async () => null };

export function platformMixedRunDeps(sql: Sql, broker: Broker): MixedRunDeps {
  return {
    runs: platformMixedRunStore(sql),
    preauthorizations: platformPreauthorizationStore(sql),
    roles: broker.deps.roles,
    teardownApprovals: brokerTeardownApprovalPort(broker.deps),
    parentReview: refusingParentReviewPort,
    now: () => broker.deps.clock.now(),
  };
}

const LIVE = new Set(["provisioning", "active", "updating", "failed", "unknown", "deleting"]);

/**
 * Ownership and dependents from the resource registry (`platform.resources`): an address is attributable to the run
 * only when the registry holds it as `managed` and not deleted/planned; anything referenced, external, missing or
 * not yet created refuses. A registry row that is not part of this run and depends on an address counts as an outside
 * dependent. The registry records no per-operation provenance, so this proves "Zenith-managed here", and the
 * run's own receipts prove which child applied it.
 */
export async function platformTeardownPlanInput(sql: Sql, state: MixedRunState): Promise<Omit<TeardownPlanInput, "now">> {
  const rows = await resourceRepo.listByEnvironment(sql, state.workspaceId, state.environmentId);
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  const inRun = new Set(Object.values(state.children).flatMap((child) => child.nodes.map((node) => node.address)));
  const owners = new Map<string, { parentOperationId: string; childId: string } | null>();
  for (const child of Object.values(state.children)) {
    for (const node of child.nodes) {
      const row = byAddress.get(node.address);
      owners.set(node.address, row && row.ownership === "managed" && LIVE.has(row.status) ? { parentOperationId: state.parentOperationId, childId: child.id } : null);
    }
  }
  return {
    owners,
    externalDependents: (address) => rows.filter((row) => !inRun.has(row.address) && row.status !== "deleted" && row.dependsOn.includes(address)).map((row) => row.address),
  };
}
