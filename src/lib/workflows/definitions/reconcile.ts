/**
 * reconcileEnvironmentWorkflow — one reconciliation pass over an environment:
 * take the `reconcile:<environmentId>` lease, observe, report, release.
 *
 * Deterministic (workflow sandbox).
 *
 * The patched path uses the same controller as HTTP reconciliation. A request
 * permits proposals, while policy, approval and the separate day-two workflow
 * retain execution authority. Pre-patch histories preserve their command shape.
 *
 * A reconcile pass is not an operation: it has no operation record, so it does
 * not call `markOperation`; the workflow id (`reconcile-<environmentId>`) is the
 * pass id and the lease holder. Its result carries the outcome.
 *
 * Failure handling: another pass holding the lease is `skipped`; any other
 * failure is `failed` with a short redacted reason. The workflow returns rather
 * than throws, so a scheduler that starts one pass per environment sees plain
 * results. Temporal-level cancellation still cancels the workflow (and the lease
 * is released first).
 */

import { CancellationScope, isCancellation, log, patched, workflowInfo } from "@temporalio/workflow";
import { FAILURE_TYPES, type LeaseRef, type ReconcileRepairSummary, type ReconcileWorkflowInput, type ReconcileWorkflowResult } from "../types";
import { activities, canonicalReconcileActivities } from "./activities";
import { describeError, failureTypeOf } from "./failures";
import { LEASE_TTL_MS } from "./policies";

function repairSummary(value: ReconcileRepairSummary | undefined): ReconcileRepairSummary {
  const counts = ["proposed", "started", "awaitingApproval", "denied", "blockedUncertain", "unsupported", "failed", "skipped"] as const;
  if (!value || !counts.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))
    throw new Error("Canonical reconciliation did not return a valid count/digest repair summary.");
  return { proposed: value.proposed, started: value.started, awaitingApproval: value.awaitingApproval, denied: value.denied, blockedUncertain: value.blockedUncertain, unsupported: value.unsupported, failed: value.failed, skipped: value.skipped, digest: value.digest };
}

export async function reconcileEnvironmentWorkflow(input: ReconcileWorkflowInput): Promise<ReconcileWorkflowResult> {
  const passId = workflowInfo().workflowId;
  const base = { environmentId: input.environmentId, repair: "not_requested" as const };
  let lease: LeaseRef | undefined;

  try {
    try {
      lease = await activities.acquireLease({ operationId: passId, scope: `reconcile:${input.environmentId}`, ttlMs: LEASE_TTL_MS });
    } catch (err) {
      if (failureTypeOf(err) === FAILURE_TYPES.leaseBusy) return { ...base, status: "skipped" };
      throw err;
    }

    // Keep until all pre-controller histories have left retention. See Temporal
    // https://docs.temporal.io/develop/typescript/workflows/versioning#patching
    const canonical = patched("reconcile-canonical-proposals-v1");
    const observed = await (canonical ? canonicalReconcileActivities : activities).reconcileObserve({ passId, workspaceId: input.workspaceId, environmentId: input.environmentId, lease, ...(canonical ? { allowAutoRepair: input.allowAutoRepair } : {}) });
    if (canonical && (!Number.isSafeInteger(observed.drift) || observed.drift < 0 || !Number.isSafeInteger(observed.unknown) || observed.unknown < 0))
      throw new Error("Canonical reconciliation did not return valid observation counts.");
    return {
      environmentId: input.environmentId,
      status: "observed",
      drift: observed.drift,
      unknown: observed.unknown,
      repair: canonical ? (input.allowAutoRepair ? "considered" : "not_requested") : (input.allowAutoRepair && observed.drift > 0 ? "not_evaluated" : "not_requested"),
      ...(canonical ? { repairs: repairSummary(observed.repairs) } : {}),
    };
  } catch (err) {
    if (isCancellation(err)) throw err;
    return { ...base, status: "failed", error: `Reconcile pass failed: ${describeError(err)}` };
  } finally {
    if (lease) {
      const held = lease;
      await CancellationScope.nonCancellable(async () => {
        try {
          await activities.releaseLease({ lease: held });
        } catch {
          log.warn("releasing the reconcile lease failed; it will expire on its own");
        }
      });
    }
  }
}
