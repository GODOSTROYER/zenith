/**
 * Durable coding-agent run (PROD-MACH-06). New workflow type: nothing existing changes.
 *
 * The workflow holds NO run state. Each iteration is one activity that loads the
 * run's checkpoint from the platform store, performs one unit of work (a batch
 * of pending tool calls or a single model turn, with the budget checked before
 * every model and tool call) and writes the next checkpoint. So a worker restart
 * or activity retry resumes from the last stored checkpoint, and workflow history
 * carries only a status string per step.
 *
 * Cancellation propagates: a workflow cancel cancels the running step (the
 * activity's abort signal reaches the model call and the loop, which stops and
 * persists), then the run is finalized as cancelled. The workflow never
 * compensates or deploys anything: the agent only proposes.
 */
import { ActivityCancellationType, ApplicationFailure, CancellationScope, defineQuery, isCancellation, proxyActivities, setHandler } from "@temporalio/workflow";

export interface CodingAgentRunInput {
  contract: "zenith.coding-agent-run.v1";
  runId: string;
  workspaceId: string;
}
export type CodingAgentRunStatus = "running" | "completed" | "budget_exhausted" | "failed" | "cancelled";
export interface CodingAgentStepResult { status: CodingAgentRunStatus }
export interface CodingAgentActivities {
  agentStep(input: CodingAgentRunInput): Promise<CodingAgentStepResult>;
  agentFinalize(input: CodingAgentRunInput & { outcome: "failed" | "cancelled"; detail: string }): Promise<CodingAgentStepResult>;
}

/** Each step is bounded by the run's own budgets (wall time default 3 min total); the activity heartbeats on every checkpoint and on a timer. */
const steps = proxyActivities<CodingAgentActivities>({
  startToCloseTimeout: "5m",
  scheduleToCloseTimeout: "15m",
  heartbeatTimeout: "30s",
  retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "30s", nonRetryableErrorTypes: ["CodingAgentContractInvalid", "CodingAgentModelUnavailable"] },
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});
const finalizer = proxyActivities<CodingAgentActivities>({ startToCloseTimeout: "30s", retry: { maximumAttempts: 5, initialInterval: "2s" } });

/** Hard upper bound on iterations; budgets stop a run long before this. */
const MAX_STEPS = 500;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const phaseQuery = defineQuery<{ phase: "starting" | "stepping" | "finished"; steps: number }>("codingAgentPhase");

function valid(input: CodingAgentRunInput): boolean {
  return !!input && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).sort().join(",") === "contract,runId,workspaceId" && input.contract === "zenith.coding-agent-run.v1" && ID.test(input.runId) && ID.test(input.workspaceId);
}

export async function codingAgentRunWorkflow(input: CodingAgentRunInput): Promise<CodingAgentStepResult> {
  if (!valid(input)) throw ApplicationFailure.nonRetryable("Coding agent run input is invalid.", "CodingAgentContractInvalid");
  const state = { phase: "starting" as "starting" | "stepping" | "finished", steps: 0 };
  setHandler(phaseQuery, () => ({ ...state }));
  const base = { contract: input.contract, runId: input.runId, workspaceId: input.workspaceId };
  try {
    state.phase = "stepping";
    for (let i = 0; i < MAX_STEPS; i++) {
      const result = await steps.agentStep(base);
      state.steps = i + 1;
      if (!result || !["running", "completed", "budget_exhausted", "failed", "cancelled"].includes(result.status)) throw ApplicationFailure.nonRetryable("Coding agent step result is invalid.", "CodingAgentContractInvalid");
      if (result.status !== "running") {
        state.phase = "finished";
        return result;
      }
    }
    return await finalizeOnce(base, "failed", "step_limit");
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() => finalizer.agentFinalize({ ...base, outcome: "cancelled", detail: "cancelled" }));
      state.phase = "finished";
      throw error;
    }
    await CancellationScope.nonCancellable(() => finalizer.agentFinalize({ ...base, outcome: "failed", detail: "step_failed" }));
    state.phase = "finished";
    throw error;
  }
}

async function finalizeOnce(base: { contract: "zenith.coding-agent-run.v1"; runId: string; workspaceId: string }, outcome: "failed" | "cancelled", detail: string): Promise<CodingAgentStepResult> {
  return finalizer.agentFinalize({ ...base, outcome, detail });
}
