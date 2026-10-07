/**
 * Typed scoped dependency outputs (PROD-MIX-03) and distributed failure and teardown order
 * (PROD-MIX-04) for mixed graphs. The join with partitions and immutable child plans is
 * `parentViewOf` in `child-view.ts`; everything else depends only on `ParentPlanView`.
 */
export { MixedOrchestrationError, type MixedOrchestrationErrorCode } from "./errors";
export { assertParentView, parentViewOf, type ChildPlanView, type ParentPlanView, type ReferenceView } from "./child-view";
export { downstreamOf, findCycle, orderChildren, upstreamOf, type ChildOrder } from "./order";
export { assessOutputConsumption, parseTypedOutput, validateOutput, type TypedOutput } from "./outputs";
export type { OutputConsumptionDecision } from "./decision";
export {
  createOutputPreauthorization, listOutputPreauthorizations, MemoryPreauthorizationStore, resolveLivePreauthorizations, revokeOutputPreauthorization,
  type OutputPreauthorization, type PreauthorizationStore,
} from "./preauthorization";
export { applyRunEvent, createRunState, isRunOpen, nextDeadline, nextRunnable, summarizeRun, type ChildRunState, type MixedRunState, type RunEvent, type RunSummary } from "./run";
export { evaluateOrdering, type OrderingSignals, type OrderingVerdict } from "./ordering-rules";
export { brokerTeardownApprovalPort, planTeardown, recordTeardownResult, releaseTeardownStep, verifyTeardownApproval, type TeardownApprovalPort } from "./teardown";
export { MemoryMixedRunStore, platformMixedRunStore, type MixedRunStore } from "./run-store";
export {
  cancelMixedRun, consumeOutputs, NO_SIGNALS, openMixedRun, proposeTeardown, readMixedRun, recordChildEvent, releaseTeardown, sweepDueMixedRuns, syncTeardownStep, tickMixedRun,
  type MixedRunDeps, type ParentReviewPort,
} from "./service";
export { platformMixedRunDeps, platformParentReviewPort, platformPreauthorizationStore, platformTeardownPlanInput, refusingParentReviewPort } from "./platform";
