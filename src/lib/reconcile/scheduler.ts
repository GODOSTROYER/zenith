/**
 * Cost-efficient scheduling of reconciliation across thousands of environments.
 *
 * Polling every environment every five minutes forever is the cost of a naive
 * controller. This one backs off while an environment is stable, resets the
 * moment something moves, spreads load deterministically, and bounds what one
 * pass may do.
 *
 *   cadence   5 min → 15 → 60 → 180 while nothing changes; back to 5 on a
 *             change (a finding appeared/cleared/escalated, the desired graph
 *             moved) or a deploy. Open drift never backs off past 60 min and
 *             an open incident never past 15 min: those are the environments
 *             where a slow answer costs something.
 *   jitter    a stable function of the environment id (FNV-1a), up to 20% of
 *             the interval, so a fleet enabled at once does not stay in lock
 *             step. Same id, same offset — every run, every process.
 *   budget    per pass: at most N environments and ~20 s of wall clock
 *             (`pass.ts`), claimed best-first.
 *   priority  recent deploys and open incidents are served first. A priority
 *             point is worth `PRIORITY_BOOST_MS` of "overdue-ness", so a low
 *             priority environment that has waited long enough still wins:
 *             ordering is `nextRunAt − priority × boost` (an index expression
 *             the SQL adapter can reproduce).
 *   scope     environments with no verified provider connection are not
 *             reconciled, and neither are sandbox environments unless the
 *             pass is configured to include them.
 *
 * Everything here is a pure function of (environment, previous schedule,
 * outcome, now). State lives behind the `ReconcileStatePort`; the in-memory
 * implementation is `MemoryReconcileBackend` (`memory.ts`).
 */
import { fnv1a } from "./util";
import type { ReconcileEnvironment, SchedulableEnvironment } from "./types";

const MIN = 60_000;

/** The backoff ladder, in ms. */
export const BACKOFF_STEPS_MS: readonly number[] = [5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN];

export interface SchedulerConfig {
  steps: readonly number[];
  /** share of the interval the deterministic jitter may add (default 0.2) */
  jitterFraction: number;
  /** include sandbox-class and sandbox-provider environments (default false) */
  includeSandbox: boolean;
  /** how much "overdue" one priority point is worth (default 10 min) */
  priorityBoostMs: number;
  /** a deploy this recent is high priority (default 30 min) */
  recentDeployMs: number;
  /** highest backoff step index an environment with open drift may reach (default 2 = 60 min) */
  openFindingsMaxStep: number;
  /** highest backoff step index an environment with an open incident may reach (default 1 = 15 min) */
  openIncidentMaxStep: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  steps: BACKOFF_STEPS_MS,
  jitterFraction: 0.2,
  includeSandbox: false,
  priorityBoostMs: 10 * MIN,
  recentDeployMs: 30 * MIN,
  openFindingsMaxStep: 2,
  openIncidentMaxStep: 1,
};

export const resolveSchedulerConfig = (c: Partial<SchedulerConfig> | undefined): SchedulerConfig => ({ ...DEFAULT_SCHEDULER_CONFIG, ...(c ?? {}) });

/** The persisted schedule of one environment (`platform.reconcile_state`). */
export interface ReconcileSchedule {
  workspaceId: string;
  environmentId: string;
  /** index into `steps`: the interval that follows the most recent stable run */
  stepIndex: number;
  nextRunAt: string;
  priority: number;
  lastRunAt?: string;
  lastChangedAt?: string;
  lastGraphDigest?: string;
  lastOutcome?: ScheduleOutcome["kind"];
  consecutiveFailures: number;
}

/** What happened on a run, as far as scheduling is concerned. */
export type ScheduleOutcome =
  | { kind: "reconciled"; changed: boolean; openFindings: number; graphDigest?: string }
  /** nothing was deployed or observable yet */
  | { kind: "nothing_to_reconcile" }
  /** a mutation holds the environment: look again soon, it is about to change */
  | { kind: "busy" }
  /** not reconcilable (no verified connection, sandbox): park it at the slowest step */
  | { kind: "ineligible" }
  | { kind: "failed" };

/** Deterministic jitter in `[0, fraction × intervalMs)` from the environment id alone. */
export function jitterMs(environmentId: string, intervalMs: number, fraction = DEFAULT_SCHEDULER_CONFIG.jitterFraction): number {
  return Math.floor((fnv1a(`reconcile:${environmentId}`) / 0x1_0000_0000) * Math.max(0, fraction) * intervalMs);
}

const clampStep = (steps: readonly number[], i: number): number => Math.max(0, Math.min(steps.length - 1, Math.trunc(i)));

/** 3 for a fresh deploy and an open incident both; +2 each. Higher is served first. */
export function priorityOf(env: SchedulableEnvironment, now: Date, config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): number {
  const deployedAt = env.lastDeployAt ? Date.parse(env.lastDeployAt) : Number.NaN;
  const recentDeploy = Number.isFinite(deployedAt) && now.getTime() - deployedAt <= config.recentDeployMs && deployedAt <= now.getTime() + MIN;
  return (recentDeploy ? 2 : 0) + ((env.openIncidents ?? 0) > 0 ? 2 : 0);
}

/** May this environment be reconciled at all, and if not, why. */
export function eligibility(env: ReconcileEnvironment, config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): { ok: true } | { ok: false; reason: "sandbox" | "no_connection" | "connection_not_verified" } {
  const simulated = env.class === "sandbox" || env.provider === "sandbox" || env.provider === "localstack";
  if (simulated) return config.includeSandbox ? { ok: true } : { ok: false, reason: "sandbox" };
  if (!env.connection) return { ok: false, reason: "no_connection" };
  if (env.connection.status !== "verified") return { ok: false, reason: "connection_not_verified" };
  return { ok: true };
}

/** The retry interval after `failures` consecutive failures: 5, 10, 20, 40 min, then the third step (60). */
const failureIntervalMs = (steps: readonly number[], failures: number): number => Math.min(steps[0] * 2 ** Math.max(0, failures - 1), steps[clampStep(steps, 2)]);

/**
 * The schedule after a run. Stable runs climb the ladder, a change or a deploy
 * returns to the bottom, a failure retries on its own short ladder without
 * disturbing the stable step.
 */
export function scheduleAfterRun(input: {
  environment: SchedulableEnvironment;
  previous: ReconcileSchedule | null;
  outcome: ScheduleOutcome;
  now: Date;
  config?: Partial<SchedulerConfig>;
}): ReconcileSchedule {
  const { environment, previous, outcome, now } = input;
  const config = resolveSchedulerConfig(input.config);
  const { steps } = config;
  const prevStep = clampStep(steps, previous?.stepIndex ?? 0);
  const failures = outcome.kind === "failed" ? (previous?.consecutiveFailures ?? 0) + 1 : 0;

  let step = prevStep;
  let interval: number;
  switch (outcome.kind) {
    case "reconciled": {
      step = outcome.changed ? 0 : clampStep(steps, prevStep + 1);
      if (outcome.openFindings > 0) step = Math.min(step, config.openFindingsMaxStep);
      break;
    }
    case "nothing_to_reconcile":
      step = clampStep(steps, prevStep + 1);
      break;
    case "busy":
      step = 0;
      break;
    case "ineligible":
      step = steps.length - 1;
      break;
    case "failed":
      break;
  }
  if ((environment.openIncidents ?? 0) > 0) step = Math.min(step, config.openIncidentMaxStep);
  interval = outcome.kind === "failed" ? failureIntervalMs(steps, failures) : steps[clampStep(steps, step)];
  interval = Math.max(1, interval);

  const at = now.toISOString();
  const changedNow = outcome.kind === "reconciled" && outcome.changed;
  return {
    workspaceId: environment.workspaceId,
    environmentId: environment.environmentId,
    stepIndex: step,
    nextRunAt: new Date(now.getTime() + interval + jitterMs(environment.environmentId, interval, config.jitterFraction)).toISOString(),
    priority: priorityOf(environment, now, config),
    lastRunAt: at,
    ...(changedNow ? { lastChangedAt: at } : previous?.lastChangedAt ? { lastChangedAt: previous.lastChangedAt } : {}),
    ...(outcome.kind === "reconciled" && outcome.graphDigest ? { lastGraphDigest: outcome.graphDigest } : previous?.lastGraphDigest ? { lastGraphDigest: previous.lastGraphDigest } : {}),
    lastOutcome: outcome.kind,
    consecutiveFailures: failures,
  };
}

/**
 * A deploy/apply finished at `at`: return to the bottom of the ladder and look
 * again one step-0 interval after it. Idempotent — a deploy the last run
 * already saw (`at <= lastRunAt`), or one that would not bring the next run
 * forward, changes nothing, so a signal window that overlaps the previous pass
 * is harmless. An environment with no schedule yet is already due.
 */
export function applyNudge(schedule: ReconcileSchedule | null, input: { at: string; config?: Partial<SchedulerConfig> }): ReconcileSchedule | null {
  if (!schedule) return null;
  const config = resolveSchedulerConfig(input.config);
  const at = Date.parse(input.at);
  if (!Number.isFinite(at)) return schedule;
  if (schedule.lastRunAt && at <= Date.parse(schedule.lastRunAt)) return schedule;
  const soon = at + config.steps[0] + jitterMs(schedule.environmentId, config.steps[0], config.jitterFraction);
  const current = Date.parse(schedule.nextRunAt);
  if (schedule.stepIndex === 0 && current <= soon) return schedule;
  return { ...schedule, stepIndex: 0, nextRunAt: new Date(Math.min(current, soon)).toISOString() };
}

/** The ordering key: earlier is served first; a priority point is worth `priorityBoostMs` of overdue-ness. */
export const effectiveDueAt = (s: Pick<ReconcileSchedule, "nextRunAt" | "priority">, config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG): number =>
  Date.parse(s.nextRunAt) - s.priority * config.priorityBoostMs;

/**
 * Pick what this pass should run: due at `now`, best first, at most `limit`.
 * Ties break on environment id so two passes over the same state agree.
 */
export function selectDue<T extends { schedule: Pick<ReconcileSchedule, "nextRunAt" | "priority" | "environmentId"> }>(
  items: readonly T[],
  now: Date,
  limit: number,
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG
): T[] {
  return items
    .filter((i) => Date.parse(i.schedule.nextRunAt) <= now.getTime())
    .sort((a, b) => effectiveDueAt(a.schedule, config) - effectiveDueAt(b.schedule, config) || (a.schedule.environmentId < b.schedule.environmentId ? -1 : a.schedule.environmentId > b.schedule.environmentId ? 1 : 0))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

/* ---------------------------------- port ---------------------------------- */

export interface ClaimedEnvironment {
  environment: SchedulableEnvironment;
  /** null for an environment that has never been scheduled (it is due immediately) */
  schedule: ReconcileSchedule | null;
}

/**
 * Schedule persistence (`platform.reconcile_state`). The SQL adapter's
 * `claimDue` is one statement: due (`next_run_at <= now` or no row), unclaimed
 * (`claimed_until` null or past), eligible (sandbox/connection filter), ordered
 * by `next_run_at − priority × interval '10 minutes'`, `limit`, claiming with
 * `FOR UPDATE SKIP LOCKED` so two concurrent passes never take the same row.
 */
export interface ReconcileStatePort {
  claimDue(input: { now: Date; limit: number; claimMs: number; holder: string; includeSandbox: boolean }): Promise<ClaimedEnvironment[]>;
  /** Persist the schedule and release the claim. */
  complete(input: { environment: SchedulableEnvironment; schedule: ReconcileSchedule }): Promise<void>;
  /** Release a claim without touching the schedule (the pass ran out of budget first). */
  release(input: { workspaceId: string; environmentId: string }): Promise<void>;
  /** Apply a deploy signal to a schedule (see `applyNudge`). */
  nudge(input: { workspaceId: string; environmentId: string; at: string }): Promise<void>;
}
