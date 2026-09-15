/**
 * Move a just-dispatched simulated deployment, inside the request that
 * dispatched it.
 *
 * The problem this solves is the difference between "the canvas shows my agent
 * working" and "nothing happened". `deployment.deploy` returns
 * `{ status: 'applying' }` immediately and the engine's 250 ms ticker is off on
 * Postgres and on serverless — a timer callback there has no snapshot to read.
 * A sandbox deploy is eight to twenty steps of roughly a second each, so
 * without help the *first* step waits for the five-minute `tick.yml` pass.
 *
 * So the request that dispatched the operation spends a bounded few seconds
 * advancing it, and then answers. Typically that is the whole plan phase and
 * the first apply steps, and the operation result the plugin receives already
 * carries a deployment whose status has moved.
 *
 * Four rules, each of which is the reason for a line below:
 *
 * 1. **It runs on the request's own snapshot, never `inCronScope()`.** The cron
 *    scope primes an *unfiltered* snapshot — every workspace, every row — which
 *    inside a tenant's request is both a large read and a tenancy smell. The
 *    action just wrote into this request's snapshot; `engineTick()` reads and
 *    advances exactly those rows.
 * 2. **It never throws.** It runs after the operation's outcome is already
 *    durable. Nothing it does may change what the caller is told happened.
 * 3. **It is bounded** by `ENGINE_ADVANCE_BUDGET_MS`, and stops the instant
 *    nothing is in flight — the same loop shape `engineTickPass()` already
 *    proves.
 * 4. **A 409 from the trailing flush is swallowed.** Another instance advanced
 *    the same deployment and won the version guard. That is a success.
 */
import { db, flushPendingAsync } from '@/lib/db/store';
import { engine, engineTick } from '@/lib/engine/engine';
import { log } from '@/lib/log';

/** How long a dispatching request may spend advancing what it dispatched. */
export const ENGINE_ADVANCE_BUDGET_MS = 6_000;

/** How long one `engineTick()` is given to make progress before the next. Matches `cron.ts`. */
const ENGINE_STEP_MS = 250;

/** Kinds whose dispatch produces a deployment worth advancing. */
const ADVANCING_ACTIONS = new Set(['deploy.apply', 'deploy.rollback', 'deploy.promote']);

/** True when this action's dispatch is worth spending the budget on. */
export const advancesDeployment = (action: string): boolean => ADVANCING_ACTIONS.has(action);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.(); });

/**
 * Best-effort. Never throws. Never changes an operation's outcome.
 *
 * Frozen contract (WORK-GRAPH-2 F7).
 */
export async function advanceAfterDispatch(
  workspaceId: string,
  budgetMs: number = ENGINE_ADVANCE_BUDGET_MS
): Promise<{ ticks: number; ms: number }> {
  const started = Date.now();
  let ticks = 0;
  try {
    const workspaceOf = (projectId: string): string | undefined =>
      db().projects.find((p) => p.id === projectId)?.workspaceId;
    const inFlight = (): number =>
      db().deployments.filter(
        (d) => (d.status === 'applying' || d.status === 'verifying') && workspaceOf(d.projectId) === workspaceId
      ).length;

    // `engineTick()` only advances deployments the engine's in-memory active
    // set knows about, and this instance's set may be empty or was populated
    // from a *filtered* snapshot during an earlier request.
    engine.resumeInFlight();
    const deadline = started + Math.max(0, budgetMs);
    while (inFlight() > 0 && Date.now() < deadline) {
      engineTick();
      ticks++;
      if (inFlight() === 0) break;
      await sleep(ENGINE_STEP_MS);
    }
  } catch (error) {
    log.warn('engine advance after dispatch failed', { scope: 'agent-control', error });
    return { ticks, ms: Date.now() - started };
  }

  try {
    await flushPendingAsync();
  } catch (error) {
    // The version-guarded write-back lost to another instance, which means that
    // instance advanced the same deployment. Losing that race is the system
    // working, not a failure to report.
    log.info('engine advance flush conflicted; another instance advanced this deployment', {
      scope: 'agent-control', error,
    });
  }
  return { ticks, ms: Date.now() - started };
}
