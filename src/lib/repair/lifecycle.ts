/**
 * The canonical observation-to-repair lifecycle (PROD-OBS-01), one door.
 *
 *   observe    bounded reads in one read-only credential session (reconcile/observe)
 *   diagnose   classification of the drift, hysteresis into a durable incident,
 *              deterministic stability admission (PROD-OBS-03)
 *   propose    a `drift.repair` capability request, evaluated by the capability
 *              broker (policy allow / require approval / deny)
 *   approval   approval stays bound to the immutable proposal and a human
 *              browser session; nothing here approves anything
 *   remediate  an ALLOWED operation is claimed through the broker and handed to
 *              the durable day-two workflow (lease, grant, readback verify)
 *   verify     the NEXT observation re-reads the environment: an earlier repair
 *              is `cleared` (incident closes by hysteresis), `still_present`
 *              (escalated to a person) or `unverifiable` (no claim of success)
 *
 * Every entry point goes through `runRepairLifecycle`: the Temporal
 * `reconcileObserve` activity (`reconcileObserveOnce`), the HTTP tick and the
 * durable sweep (`reconcilePass`). Nothing else observes-and-repairs, so the
 * stages, gates and refusals cannot drift apart between paths.
 *
 * The lifecycle never executes a repair itself and never widens authority: a
 * request flag only lets a proposal be considered. Each finding ends in
 * exactly one disposition; a finding that is not repaired carries a typed
 * refusal with a reason (see `refusals.ts`).
 */
import { digest } from "@/lib/controlplane/digest";
import { reconcileEnvironment, type ReconcileEnvironmentInput } from "@/lib/reconcile/core";
import type { ReconcileResult, RepairDecision, RepairVerification } from "@/lib/reconcile/types";
import type { ReconcileRepairSummary } from "@/lib/workflows/types";
import { refusalOf, type LifecycleStage, type RepairRefusal } from "./refusals";

/** Which entry point drove the lifecycle. Recorded for audit; it never changes behaviour. */
export type LifecycleEntry = "temporal" | "tick" | "sweep" | "manual";

export type LifecycleDisposition =
  /** refused: see `refusal` */
  | "refused"
  /** a person must approve the exact proposal first */
  | "awaiting_approval"
  /** policy denied the proposal */
  | "denied"
  /** allowed and handed to the durable workflow */
  | "dispatched"
  /** allowed, but the workflow start is unconfirmed: inspect the operation */
  | "dispatch_unconfirmed";

export interface LifecycleItem {
  address: string;
  findingClass: RepairDecision["class"];
  /** the last stage this finding reached this pass */
  stage: LifecycleStage;
  disposition: LifecycleDisposition;
  operationId?: string;
  refusal?: RepairRefusal;
}

export interface RepairLifecycleInput extends ReconcileEnvironmentInput {
  entry: LifecycleEntry;
}

export interface RepairLifecycleResult {
  entry: LifecycleEntry;
  /** the full controller result (observation, diff, decisions, verifications) */
  reconcile: ReconcileResult;
  /** one item per finding that reached the repair stages; unrepairable findings carry typed refusals */
  items: LifecycleItem[];
  verifications: RepairVerification[];
}

export function lifecycleItem(decision: RepairDecision): LifecycleItem {
  const base = { address: decision.address, findingClass: decision.class, ...(decision.operationId ? { operationId: decision.operationId } : {}) };
  const refused = refusalOf(decision);
  if (refused) {
    const disposition: LifecycleDisposition = refused.code === "policy_denied" ? "denied" : refused.code === "start_failed" ? "dispatch_unconfirmed" : "refused";
    return { ...base, stage: refused.stage, disposition, refusal: refused };
  }
  if (decision.started === true) return { ...base, stage: "remediate", disposition: "dispatched" };
  return { ...base, stage: "approval", disposition: "awaiting_approval" };
}

/** Pure projection of a controller result onto the lifecycle's per-finding view. */
export function lifecycleItems(result: ReconcileResult): LifecycleItem[] {
  return result.repairs.map(lifecycleItem);
}

/** Counts and a digest only: what is safe to carry across the Temporal boundary. */
export function summarizeRepairs(result: Pick<ReconcileResult, "report" | "repairs">): ReconcileRepairSummary {
  const repairs = result.repairs;
  return {
    proposed: repairs.filter((r) => r.status === "proposed").length,
    started: repairs.filter((r) => r.started === true).length,
    awaitingApproval: repairs.filter((r) => r.outcome === "require_approval").length,
    denied: repairs.filter((r) => r.outcome === "deny").length,
    blockedUncertain: repairs.filter((r) => r.reason === "repair_uncertain").length,
    unsupported: repairs.filter((r) => r.reason === "repair_not_supported").length,
    failed: repairs.filter((r) => r.status === "failed" || r.started === false).length,
    skipped: repairs.filter((r) => r.status === "skipped").length,
    digest: digest({
      graphDigest: result.report?.graphDigest ?? null,
      repairs: repairs.map(({ address, class: findingClass, status, outcome, operationId, started, reason }) => ({ address, findingClass, status, outcome, operationId, started, reason })),
    }),
  };
}

export async function runRepairLifecycle(input: RepairLifecycleInput): Promise<RepairLifecycleResult> {
  const { entry, ...rest } = input;
  const reconcile = await reconcileEnvironment(rest);
  return { entry, reconcile, items: lifecycleItems(reconcile), verifications: reconcile.verifications };
}
