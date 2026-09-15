/**
 * The bounded engine advance that runs inside the request that dispatched.
 *
 * The thing being proven is small and easy to fake, so the setup is deliberate:
 * **`ZENITH_SERVERLESS=1` is set before the engine is imported**, which is the
 * one condition under which `ensureEngine()` starts no background ticker
 * (`engine.ts:345`). Nothing in the process can move a deployment except the
 * call under test. On a host that *does* have a ticker this test would pass
 * whether `advanceAfterDispatch()` worked or not, which is worth nothing.
 *
 * That is also the topology this function exists for: on Vercel and on Postgres
 * there is no ticker, so without it the first step of a simulated deploy waits
 * for the five-minute `tick.yml` pass and the canvas shows nothing happening.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import type { ActionContext } from '@/lib/actions/core';
import { tempDataDir } from './_support/data-dir';

tempDataDir('zenith-agent-advance-', { fast: true });
// Before any application import: the ticker gate is read when the engine module
// first initialises, and a ticker started here would be the thing advancing the
// deployment instead of the function under test.
process.env.ZENITH_SERVERLESS = '1';

const { runAction } = await import('@/lib/actions/core');
const { resetDb, q } = await import('@/lib/db/store');
await import('@/lib/actions/defs');
const { advanceAfterDispatch, advancesDeployment, ENGINE_ADVANCE_BUDGET_MS } =
  await import('@/lib/agent-access/control/advance');

const ctx: ActionContext = { workspaceId: 'ws-advance', actor: { type: 'user', id: 'you', name: 'you' } };
let projectId = '';
let environmentId = '';

async function exec(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { result } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: 'execute' });
  return result!;
}

/** How much of the deployment has actually happened, as one number. */
const progress = (id: string): number => {
  const d = q.deployment(id);
  return (d?.steps ?? []).filter((s) => s.status === 'done' || s.status === 'failed').length;
};

beforeAll(async () => {
  resetDb({ workspaces: [{ id: 'ws-advance', name: 'Advance', slug: 'advance', createdAt: new Date().toISOString() }] });
  const created = await exec('project.applyBlueprint', { blueprint: 'internal-tool', name: 'Atlas' });
  expect(created.ok).toBe(true);
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  environmentId = data.environmentId;
});

describe('advanceAfterDispatch', () => {
  it('only claims the deployment actions', () => {
    expect(advancesDeployment('deploy.apply')).toBe(true);
    expect(advancesDeployment('deploy.rollback')).toBe(true);
    expect(advancesDeployment('deploy.promote')).toBe(true);
    // A manifest edit has nothing in flight; spending six seconds on it would
    // be six seconds of a request's budget for nothing.
    expect(advancesDeployment('project.updateManifest')).toBe(false);
    expect(advancesDeployment('app.publish')).toBe(false);
  });

  it('moves a dispatched sandbox deployment inside its budget, where nothing else would', async () => {
    const result = await exec('deploy.apply', {}, { projectId, environmentId });
    expect(result.ok).toBe(true);
    const { deploymentId } = result.data as { deploymentId: string };

    // No ticker: half a second of wall clock changes nothing on its own. This
    // is the control, and it is what makes the assertion below mean something.
    const before = progress(deploymentId);
    await new Promise((r) => setTimeout(r, 500));
    expect(progress(deploymentId)).toBe(before);

    const started = Date.now();
    const advanced = await advanceAfterDispatch('ws-advance');
    expect(advanced.ticks).toBeGreaterThan(0);
    // Bounded: the point of a budget is that a request cannot be held open by a
    // deployment that will not finish. A little slack for the final step.
    expect(Date.now() - started).toBeLessThan(ENGINE_ADVANCE_BUDGET_MS + 2_000);
    expect(progress(deploymentId)).toBeGreaterThan(before);
    // A simulated deploy is short enough that six seconds is the whole of it.
    expect(q.deployment(deploymentId)!.status).toBe('succeeded');
  });

  it('respects a smaller budget', async () => {
    const started = Date.now();
    const advanced = await advanceAfterDispatch('ws-advance', 300);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(advanced.ms).toBeGreaterThanOrEqual(0);
  });

  it('ignores another workspace’s in-flight work', async () => {
    const advanced = await advanceAfterDispatch('ws-does-not-exist', 500);
    // Nothing of that workspace is in flight, so the loop never runs a tick.
    expect(advanced.ticks).toBe(0);
  });

  it('never throws when the engine does, and never changes an outcome', async () => {
    vi.resetModules();
    vi.doMock('@/lib/engine/engine', () => ({
      engine: { resumeInFlight: () => { throw new Error('engine unavailable'); } },
      engineTick: () => { throw new Error('engine unavailable'); },
    }));
    const fresh = await import('@/lib/agent-access/control/advance');
    // It runs after the operation's outcome is already durable. Anything it
    // throws would turn a finished operation into a reported failure.
    await expect(fresh.advanceAfterDispatch('ws-advance', 100)).resolves.toMatchObject({ ticks: 0 });
    vi.doUnmock('@/lib/engine/engine');
    vi.resetModules();
  });
});
