/**
 * `reconcilePass`: one bounded, cost-aware pass of the reconciliation
 * controller across the fleet. What `POST /api/internal/tick/reconcile` runs.
 *
 *   1. pull deploy signals and pull the affected environments' next run forward
 *   2. claim the environments that are due, best first, at most
 *      `maxEnvironments` (priority + overdue-ness; see `scheduler.ts`)
 *   3. reconcile them with bounded concurrency, each under the per-environment
 *      guard (no pass while a deploy holds the environment; no two passes on
 *      one environment)
 *   4. persist each environment's next run (backoff, reset on change), or
 *      release the claim of any environment the budget did not reach
 *
 * The budget is a START gate, like `engineTickPass`: no environment is begun
 * once ~20 s have passed, but one that has begun is allowed to finish (bounded
 * by its own environment timeout and a hard cap below the route's 60 s
 * `maxDuration`), so a slow environment is not reported as a burst of
 * `unknown` findings that only mean "we ran out of time".
 *
 * Nothing here can fail the pass for one environment's sake: a throw while
 * reconciling one is recorded as a failed run with its own short retry ladder
 * and the pass moves on. Counts, not prose, come back — a pass that says
 * nothing is indistinguishable from one that did nothing.
 */
import { reconcileEnvironment } from "./core";
import type { ReconcilePassOptions, ReconcilePassPorts, ReconcilePassResult } from "./pass-types";
import { reconcilePassPorts } from "./ports";
import { eligibility, resolveSchedulerConfig, scheduleAfterRun, type ClaimedEnvironment, type ScheduleOutcome } from "./scheduler";
import type { ReconcileResult } from "./types";
import { mapPool } from "./util";

/** The start-gate budget of one pass. */
export const RECONCILE_BUDGET_MS = 20_000;
/** No environment may run past this many ms after the pass began. */
export const RECONCILE_HARD_CAP_MS = 50_000;
export const DEFAULT_MAX_ENVIRONMENTS = 25;
export const DEFAULT_ENVIRONMENT_CONCURRENCY = 3;
/** An environment is not started with less than this left of the budget. */
const MIN_START_MS = 1_000;
const DEFAULT_SIGNAL_LOOKBACK_MS = 15 * 60_000;

export const emptyPassResult = (): ReconcilePassResult => ({
  claimed: 0,
  reconciled: 0,
  nothingToReconcile: 0,
  busy: 0,
  ineligible: 0,
  failed: 0,
  deferred: 0,
  nudged: 0,
  driftDetected: 0,
  driftCleared: 0,
  openFindings: 0,
  unreadNodes: 0,
  repairsProposed: 0,
  repairsStarted: 0,
  repairsAwaitingApproval: 0,
  repairsDenied: 0,
  saturated: false,
  timedOut: false,
  ms: 0,
});

const bounded = (v: number | undefined, fallback: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : fallback;

async function applySignals(ports: ReconcilePassPorts, now: Date, lookbackMs: number): Promise<number> {
  if (!ports.signals) return 0;
  let nudged = 0;
  try {
    const deploys = await ports.signals.deploysSince({ since: new Date(now.getTime() - lookbackMs), limit: 500 });
    const latest = new Map<string, (typeof deploys)[number]>();
    for (const d of deploys) {
      const prev = latest.get(d.environmentId);
      if (!prev || Date.parse(d.at) > Date.parse(prev.at)) latest.set(d.environmentId, d);
    }
    for (const d of latest.values()) {
      try {
        await ports.state.nudge(d);
        nudged++;
      } catch {
        // A deploy signal is an optimisation: an environment it could not reach
        // is still visited on its backoff schedule.
      }
    }
  } catch {
    // Same: never fail the pass because the signal source was unavailable.
  }
  return nudged;
}

export async function reconcilePass(options: ReconcilePassOptions = {}): Promise<ReconcilePassResult> {
  const started = Date.now();
  const ports = options.ports ?? (await reconcilePassPorts());
  const result = emptyPassResult();
  const budgetMs = bounded(options.budgetMs, RECONCILE_BUDGET_MS, RECONCILE_BUDGET_MS);
  const startGate = started + budgetMs;
  const hardDeadline = started + RECONCILE_HARD_CAP_MS;
  const maxEnvironments = bounded(options.maxEnvironments, DEFAULT_MAX_ENVIRONMENTS, 500);
  const config = resolveSchedulerConfig({ ...(options.scheduler ?? {}), ...(options.includeSandbox !== undefined ? { includeSandbox: options.includeSandbox } : {}) });
  const holder = options.holder ?? `reconcile:${crypto.randomUUID()}`;

  result.nudged = await applySignals(ports, ports.now(), bounded(options.signalLookbackMs, DEFAULT_SIGNAL_LOOKBACK_MS, 24 * 60 * 60_000));

  const claimed: ClaimedEnvironment[] =
    budgetMs > 0 && maxEnvironments > 0
      ? await ports.state.claimDue({ now: ports.now(), limit: maxEnvironments, claimMs: RECONCILE_HARD_CAP_MS + 60_000, holder, includeSandbox: config.includeSandbox })
      : [];
  result.claimed = claimed.length;
  result.saturated = maxEnvironments > 0 && claimed.length >= maxEnvironments;

  const complete = async (c: ClaimedEnvironment, outcome: ScheduleOutcome): Promise<void> => {
    await ports.state.complete({ environment: c.environment, schedule: scheduleAfterRun({ environment: c.environment, previous: c.schedule, outcome, now: ports.now(), config }) });
  };
  const release = (c: ClaimedEnvironment): Promise<void> => ports.state.release({ workspaceId: c.environment.workspaceId, environmentId: c.environment.environmentId });

  const tally = (r: ReconcileResult): void => {
    result.driftDetected += r.detected;
    result.driftCleared += r.cleared;
    result.openFindings += r.openFindings;
    result.unreadNodes += r.unread;
    for (const d of r.repairs) {
      if (d.started) result.repairsStarted++;
      if (d.status !== "proposed") continue;
      result.repairsProposed++;
      if (d.outcome === "require_approval") result.repairsAwaitingApproval++;
      if (d.outcome === "deny") result.repairsDenied++;
    }
  };

  await mapPool(claimed, bounded(options.environmentConcurrency, DEFAULT_ENVIRONMENT_CONCURRENCY, 16) || 1, async (c) => {
    const { environment } = c;
    try {
      if (startGate - Date.now() < MIN_START_MS) {
        await release(c);
        result.deferred++;
        return;
      }
      if (!eligibility(environment, config).ok) {
        result.ineligible++;
        await complete(c, { kind: "ineligible" });
        return;
      }

      let outcome: ScheduleOutcome;
      try {
        const guarded = await ports.guard.run(environment, async () => {
          const graph = await ports.loadGraph(environment);
          if (!graph) return null;
          const deadlineAt = Math.min(hardDeadline, options.reconcile?.deadlineAt ?? Number.POSITIVE_INFINITY);
          return reconcileEnvironment({ environment, graph, ports, options: { ...options.reconcile, deadlineAt } });
        });
        if (!guarded.ran) {
          result.busy++;
          if (guarded.reason === "reconcile_lease_held") {
            await release(c); // another pass is on it right now; its own completion sets the schedule
            return;
          }
          outcome = { kind: "busy" };
        } else if (guarded.value === null || guarded.value.status === "nothing_to_reconcile") {
          result.nothingToReconcile++;
          outcome = { kind: "nothing_to_reconcile" };
        } else {
          result.reconciled++;
          tally(guarded.value);
          outcome = { kind: "reconciled", changed: guarded.value.changed, openFindings: guarded.value.openFindings, ...(guarded.value.report ? { graphDigest: guarded.value.report.graphDigest } : {}) };
        }
      } catch {
        result.failed++;
        outcome = { kind: "failed" };
      }
      await complete(c, outcome);
    } catch {
      // Persisting the schedule failed: the claim expires and the environment is retried.
      result.failed++;
    }
  });

  result.timedOut = result.deferred > 0;
  result.ms = Date.now() - started;
  return result;
}
