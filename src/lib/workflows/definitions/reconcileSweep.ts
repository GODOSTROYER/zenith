/** New workflow type: historical reconcileEnvironmentWorkflow commands stay unchanged. */
import { ActivityCancellationType, ApplicationFailure, defineQuery, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

export interface ReconcileSweepInput {
  contract: "zenith.reconcile-sweep.v1";
  maxEnvironments: number;
  environmentConcurrency: number;
}
export interface ReconcileSweepActivityInput extends ReconcileSweepInput { passId: string }
/** Counts mirror the existing controller projection; no controller implementation is bundled. */
export interface ReconcileSweepCounts {
  claimed: number;
  reconciled: number;
  nothingToReconcile: number;
  busy: number;
  ineligible: number;
  failed: number;
  deferred: number;
  nudged: number;
  driftDetected: number;
  driftCleared: number;
  openFindings: number;
  unreadNodes: number;
  repairsProposed: number;
  repairsStarted: number;
  repairsAwaitingApproval: number;
  repairsDenied: number;
  saturated: boolean;
  timedOut: boolean;
  ms: number;
}
export type ReconcileSweepResult =
  | { status: "completed"; counts: ReconcileSweepCounts }
  | { status: "busy" }
  | { status: "deferred"; reason: "prerequisites_unavailable" | "pass_unconfirmed" };
export interface ReconcileSweepActivities {
  sweepReconcilePass(input: ReconcileSweepActivityInput): Promise<ReconcileSweepResult>;
}

const sweep = proxyActivities<ReconcileSweepActivities>({
  startToCloseTimeout: "90s",
  scheduleToCloseTimeout: "150s",
  heartbeatTimeout: "20s",
  // A pass may dispatch a broker-approved repair. A timeout cannot prove it did not.
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const progress = defineQuery<"waiting" | "sweeping" | "completed">("reconcileSweepPhase");

function valid(input: ReconcileSweepInput): boolean {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(",") !== "contract,environmentConcurrency,maxEnvironments") return false;
  return input.contract === "zenith.reconcile-sweep.v1" && Number.isInteger(input.maxEnvironments) && input.maxEnvironments >= 1 && input.maxEnvironments <= 25 && Number.isInteger(input.environmentConcurrency) && input.environmentConcurrency >= 1 && input.environmentConcurrency <= 3;
}

/** One finite fleet pass, counts only. Cancellation never starts compensation. */
export async function reconcileSweepWorkflow(input: ReconcileSweepInput): Promise<ReconcileSweepResult> {
  if (!valid(input)) throw ApplicationFailure.nonRetryable("Reconciliation sweep input is invalid.", "ReconcileSweepContractInvalid");
  let phase: "waiting" | "sweeping" | "completed" = "waiting";
  setHandler(progress, () => phase);
  phase = "sweeping";
  const result = await sweep.sweepReconcilePass({ contract: input.contract, maxEnvironments: input.maxEnvironments, environmentConcurrency: input.environmentConcurrency, passId: workflowInfo().runId });
  if (!result || !["completed", "busy", "deferred"].includes(result.status)) throw ApplicationFailure.nonRetryable("Reconciliation sweep result is invalid.", "ReconcileSweepContractInvalid");
  phase = "completed";
  return result;
}
