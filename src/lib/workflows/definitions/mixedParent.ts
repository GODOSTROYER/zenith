/**
 * mixedParentWorkflow (PROD-MIX-02): the parent of an ordered set of immutable
 * child plans.
 *
 *   validate -> lease -> execute_capability (one child at a time, in dependency
 *   order) -> finalize -> release
 *
 * It runs under the same `OperationRun` as every operation workflow, so the lease,
 * cancellation, terminal status and "never compensate" rules are the shared ones.
 * The workflow holds no plan data: every decision is an activity that reads the
 * durable plan, receipts and child rows, so a worker restart or a replayed
 * workflow resumes exactly where the stored state says, with the same stable
 * addresses, and never repeats a claim or a start.
 *
 * Children are real platform operations with their own workflow (`op-<childId>`),
 * claimed and started through the durable start intent, each under its own
 * approvals and guards. The parent starts the next child only after the previous
 * one has a durable `succeeded` receipt. A child that fails, is cancelled, times
 * out or is uncertain stops the parent; later children become `blocked` and
 * NOTHING is destroyed, rolled back or auto-compensated.
 *
 * Deterministic module (workflow sandbox): imports only `@temporalio/workflow`
 * and relative workflow modules (type-only for the activity contract).
 */

import { ActivityCancellationType, CancellationScope, isCancellation, proxyActivities } from "@temporalio/workflow";
import type { LeaseRef, WorkflowResult } from "../types";
import { FAILURE_TYPES } from "../types";
import { OperationHalt, OperationRun } from "./runtime";
import { describeError, failureTypeOf } from "./failures";
import { NON_RETRYABLE_TYPES } from "./policies";

export interface MixedParentWorkflowInput {
  workspaceId: string;
  operationId: string;
  environmentId: string;
  parentPlanId: string;
}

export type MixedChildOutcome = "succeeded" | "failed" | "uncertain" | "cancelled";
export type MixedAdvance =
  | { state: "started" | "waiting" }
  | { state: "blocked"; reason: string }
  | { state: MixedChildOutcome };
export interface MixedObservation { state: "adopted" | "started" | MixedChildOutcome | "blocked" }

export interface MixedActivities {
  verifyMixedParent(input: { workspaceId: string; operationId: string; parentPlanId: string }): Promise<{ order: { partitionId: string; ordinal: number }[]; childSetDigest: string }>;
  advanceMixedChild(input: { workspaceId: string; operationId: string; parentPlanId: string; partitionId: string }): Promise<MixedAdvance>;
  awaitMixedChild(input: { workspaceId: string; operationId: string; parentPlanId: string; partitionId: string; lease: LeaseRef; windowMs: number }): Promise<MixedObservation>;
  settleMixedParent(input: { workspaceId: string; operationId: string; parentPlanId: string; outcome: MixedChildOutcome; reason: string }): Promise<{ status: string }>;
}

/** Longest the parent waits on one child (its approval, which can take 24 hours, plus its run) before it stops. */
const CHILD_WAIT_MS = 26 * 60 * 60 * 1000;
/** One observation window; bounded below the 5-minute lease so every window renews it. */
const WINDOW_MS = 4 * 60 * 1000;

const reads = proxyActivities<MixedActivities>({
  startToCloseTimeout: "5m",
  retry: { initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "30s", maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_TYPES },
});
/** advance may claim and start: one attempt, because a lost response must be resolved by reading durable state, not by a blind replay at this layer. */
const advancing = proxyActivities<MixedActivities>({
  startToCloseTimeout: "5m",
  retry: { maximumAttempts: 1, nonRetryableErrorTypes: NON_RETRYABLE_TYPES },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const observing = proxyActivities<MixedActivities>({
  startToCloseTimeout: "6m",
  heartbeatTimeout: "60s",
  retry: { initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "30s", maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_TYPES },
});
const settling = proxyActivities<MixedActivities>({
  startToCloseTimeout: "1m",
  scheduleToCloseTimeout: "1h",
  retry: { initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "30s", nonRetryableErrorTypes: NON_RETRYABLE_TYPES },
});

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
function validInput(input: MixedParentWorkflowInput): boolean {
  return !!input && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).sort().join(",") === "environmentId,operationId,parentPlanId,workspaceId"
    && [input.workspaceId, input.operationId, input.environmentId, input.parentPlanId].every((value) => typeof value === "string" && ID.test(value));
}

const outcomeOfHalt = (status: OperationHalt["status"]): MixedChildOutcome => (status === "uncertain" ? "uncertain" : status === "cancelled" ? "cancelled" : "failed");

export async function mixedParentWorkflow(input: MixedParentWorkflowInput): Promise<WorkflowResult> {
  if (!validInput(input)) {
    return { operationId: typeof input?.operationId === "string" ? input.operationId : "unknown", status: "failed", error: "The mixed parent workflow input is invalid; nothing was started.", steps: [] };
  }
  const base = { workspaceId: input.workspaceId, operationId: input.operationId, parentPlanId: input.parentPlanId };
  const run = new OperationRun({ operationId: input.operationId, leaseScope: `env:${input.environmentId}`, steps: ["validate", "lease", "execute_capability", "finalize", "release"] });
  // A plan-level refusal is a clean, definitive failure: nothing had been started.
  const refusal = (err: unknown): unknown => (failureTypeOf(err) === FAILURE_TYPES.stepFailed ? run.halt("failed", describeError(err)) : err);

  return run.run(async () => {
    try {
      const verified = await run.step("validate", async () => {
        try { return await reads.verifyMixedParent(base); } catch (err) { throw refusal(err); }
      }, (v) => `${v.order.length} child(ren) · ${v.childSetDigest.slice(0, 19)}`);
      await run.acquireLeaseStep();

      await run.step("execute_capability", async () => {
        for (const child of [...verified.order].sort((a, b) => a.ordinal - b.ordinal)) {
          const deadline = Date.now() + CHILD_WAIT_MS;
          let state: string = "adopted";
          for (;;) {
            if (state === "adopted") {
              let advance;
              try { advance = await advancing.advanceMixedChild({ ...base, partitionId: child.partitionId }); } catch (err) { throw refusal(err); }
              state = advance.state;
              if (advance.state === "blocked") throw run.halt("failed", `Child ${child.ordinal + 1} was not started: ${advance.reason}. Nothing was changed or rolled back.`);
            }
            if (state === "succeeded") break;
            if (state === "failed" || state === "cancelled") throw run.halt(state === "cancelled" ? "cancelled" : "failed", `Child ${child.ordinal + 1} ended ${state}; the remaining children were not started. Nothing was rolled back or destroyed.`);
            if (state === "uncertain") throw run.halt("uncertain", `Child ${child.ordinal + 1} ended uncertain; the remaining children were not started. Inspect it; nothing was rolled back or destroyed.`);
            if (Date.now() > deadline) {
              throw run.halt(state === "started" ? "uncertain" : "failed", state === "started"
                ? `Child ${child.ordinal + 1} was still running after the wait limit; its outcome is unconfirmed and nothing was cancelled or rolled back.`
                : `Child ${child.ordinal + 1} never became startable within the wait limit; nothing was started.`);
            }
            const observed = await observing.awaitMixedChild({ ...base, partitionId: child.partitionId, lease: run.requireLease(), windowMs: WINDOW_MS });
            state = observed.state === "blocked" ? "failed" : observed.state;
          }
        }
        return verified.order.length;
      }, (count) => `${count} child(ren) succeeded in dependency order`);
    } catch (err) {
      const outcome: MixedChildOutcome = isCancellation(err) ? "cancelled" : err instanceof OperationHalt ? outcomeOfHalt(err.status) : "uncertain";
      await CancellationScope.nonCancellable(async () => {
        try { await settling.settleMixedParent({ ...base, outcome, reason: "the parent stopped before every child ran" }); } catch { /* the plan row is a projection; the receipts stay authoritative */ }
      });
      throw err;
    }
    // Reached only when every child succeeded. The activity re-checks the receipts and downgrades if any is missing.
    await settling.settleMixedParent({ ...base, outcome: "succeeded", reason: "all children succeeded" });
  });
}

