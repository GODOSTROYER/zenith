/**
 * Contracts of the cron-driven pass (`reconcilePass`): the extra ports it needs
 * beyond a single environment's reconciliation, its options and its result.
 */
import type { ResourceGraph } from "@/lib/resources/types";
import type { SchedulerConfig, ReconcileStatePort } from "./scheduler";
import type { ReconcileEnvironment, ReconcileOptions, ReconcilePorts } from "./types";

export type GuardResult<T> = { ran: true; value: T } | { ran: false; reason: "reconcile_lease_held" | "mutation_in_flight" };

/**
 * Mutual exclusion for one environment's pass. The adapter takes the
 * `reconcile:<environmentId>` lease (short TTL, released in `finally`) and
 * refuses with `mutation_in_flight` while the `env:<environmentId>` lease is
 * held or a deploy/apply operation is open: reading mid-apply would report the
 * deploy's own half-finished changes as drift. Never hold `env:<id>` here.
 */
export interface EnvironmentGuard {
  run<T>(environment: ReconcileEnvironment, fn: () => Promise<T>): Promise<GuardResult<T>>;
}

/** Deploy signals, pulled (stateless): the lookback may overlap the previous pass; `applyNudge` is idempotent. */
export interface ReconcileSignalsPort {
  deploysSince(input: { since: Date; limit: number }): Promise<{ workspaceId: string; environmentId: string; at: string }[]>;
}

export interface ReconcilePassPorts extends ReconcilePorts {
  state: ReconcileStatePort;
  /**
   * The desired graph of what is deployed in the environment (the graph of its
   * current applied revision). `null` when nothing has been deployed yet.
   */
  loadGraph(environment: ReconcileEnvironment): Promise<ResourceGraph | null>;
  guard: EnvironmentGuard;
  signals?: ReconcileSignalsPort;
}

export interface ReconcilePassOptions {
  /** wall-clock budget (default and ceiling: `RECONCILE_BUDGET_MS`, 20 s, like `engineTickPass`) */
  budgetMs?: number;
  /** environments claimed per pass (default 25) */
  maxEnvironments?: number;
  /** environments reconciled at once (default 3) */
  environmentConcurrency?: number;
  /** include sandbox-class / sandbox-provider environments (default false) */
  includeSandbox?: boolean;
  scheduler?: Partial<SchedulerConfig>;
  reconcile?: ReconcileOptions;
  /** how far back to look for deploy signals (default 15 min) */
  signalLookbackMs?: number;
  /** claim holder id (default `reconcile:<random>`) */
  holder?: string;
  /** inject ports (tests, or the orchestrator's own wiring); default: `reconcilePassPorts()` */
  ports?: ReconcilePassPorts;
}

export interface ReconcilePassResult {
  /** environments the pass claimed */
  claimed: number;
  reconciled: number;
  nothingToReconcile: number;
  /** a mutation held the environment; it is looked at again soon */
  busy: number;
  /** no verified connection / sandbox: parked at the slowest step */
  ineligible: number;
  failed: number;
  /** claimed but not started because the budget ran out; released, due next pass */
  deferred: number;
  /** deploy signals applied to schedules */
  nudged: number;
  driftDetected: number;
  driftCleared: number;
  /** findings open across the reconciled environments */
  openFindings: number;
  /** nodes that could not be read (reported as unknown/inaccessible) */
  unreadNodes: number;
  repairsProposed: number;
  repairsStarted: number;
  repairsAwaitingApproval: number;
  repairsDenied: number;
  /** the pass claimed as many environments as it was allowed: more may be due */
  saturated: boolean;
  /** the budget ran out with claimed work left */
  timedOut: boolean;
  ms: number;
}
