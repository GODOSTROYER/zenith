/**
 * Reconciliation controller, one door: `@/lib/reconcile`.
 *
 *   types        ports, options, results (the contract)
 *   core         `reconcileEnvironment` — observe → diff → policy → propose for ONE environment
 *   observe      bounded, timed-out reads in one credential session per provider
 *   diff         report diff, drift.detected / drift.cleared events, correlation ids
 *   repair       candidate selection, pacing, `drift.repair` proposals (never executes)
 *   scheduler    backoff, jitter, priority, eligibility (pure) + the state port
 *   pass         `reconcilePass` — one bounded pass across the fleet (the cron route)
 *   ports        `wireReconcilePorts` / `reconcilePassPorts` (memory mode: ZENITH_RECONCILE_MEMORY=1)
 *   memory       in-memory store/state/guard/signals for tests and local development
 *
 * The controller never repairs anything itself: a repair is a capability
 * request to the broker, and an allowed operation is handed to the workflow.
 */
export { reconcileEnvironment, resolveOptions, type ReconcileEnvironmentInput } from "./core";
export { reconcilePass, emptyPassResult, RECONCILE_BUDGET_MS, RECONCILE_HARD_CAP_MS, DEFAULT_MAX_ENVIRONMENTS, DEFAULT_ENVIRONMENT_CONCURRENCY } from "./pass";
export type {
  EnvironmentGuard,
  GuardResult,
  ReconcilePassOptions,
  ReconcilePassPorts,
  ReconcilePassResult,
  ReconcileSignalsPort,
} from "./pass-types";
export { memoryReconcileBackend, reconcilePassPorts, reconcileWired, resetMemoryReconcileBackend, wireReconcilePorts, RECONCILE_MEMORY_ENV, type ReconcilePortsFactory } from "./ports";
export { MemoryReconcileBackend, type MemoryBackendInit, type MemoryOperation } from "./memory";
export { correlationIdFor, diffFindings, driftEvents, findingKey, findingSignature, nextFindingSince, type FindingDiff } from "./diff";
export { buildRepairRequest, proposeRepairs, selectRepairCandidates, type Candidate, type CandidateSelection, type RepairInput } from "./repair";
export { observeNodes, failureObservation, type ObservableNode, type ObservedNode } from "./observe";
export {
  BACKOFF_STEPS_MS,
  DEFAULT_SCHEDULER_CONFIG,
  applyNudge,
  effectiveDueAt,
  eligibility,
  jitterMs,
  priorityOf,
  resolveSchedulerConfig,
  scheduleAfterRun,
  selectDue,
  type ClaimedEnvironment,
  type ReconcileSchedule,
  type ReconcileStatePort,
  type ScheduleOutcome,
  type SchedulerConfig,
} from "./scheduler";
export { describeError, isAccessDenied, redactText } from "./redact";
export { ReconcileError, type ReconcileErrorCode } from "./errors";
export * from "./types";
