// Historical reconcile definition from 83ec97f. Only import paths are relocated.
/**
 * reconcileEnvironmentWorkflow — one reconciliation pass over an environment:
 * take the `reconcile:<environmentId>` lease, observe, report, release.
 *
 * Deterministic (workflow sandbox).
 *
 * Observe-and-report only. `allowAutoRepair` is accepted and reported back
 * (`repair: "not_implemented"` when drift was found), but this workflow never
 * proposes or runs a repair: doing so needs a `proposeRepair` activity that
 * files a NEW operation through the capability broker (so policy, approval and
 * the operation ledger all apply). That activity does not exist yet, so the
 * honest behaviour is to say so rather than to pretend a repair was considered.
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

import { CancellationScope, isCancellation, log, workflowInfo } from "@temporalio/workflow";
import { FAILURE_TYPES, type LeaseRef, type ReconcileWorkflowInput, type ReconcileWorkflowResult } from "../../../src/lib/workflows/types";
import { activities } from "../../../src/lib/workflows/definitions/activities";
import { describeError, failureTypeOf } from "../../../src/lib/workflows/definitions/failures";
import { LEASE_TTL_MS } from "../../../src/lib/workflows/definitions/policies";

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

    const observed = await activities.reconcileObserve({ passId, workspaceId: input.workspaceId, environmentId: input.environmentId, lease });
    return {
      environmentId: input.environmentId,
      status: "observed",
      drift: observed.drift,
      unknown: observed.unknown,
      repair: input.allowAutoRepair && observed.drift > 0 ? "not_implemented" : "not_requested",
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
