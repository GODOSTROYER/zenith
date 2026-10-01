/**
 * `reconcileObserveOnce`: the body of the Temporal `reconcileObserve` activity
 * (`ReconcileActivities`, `src/lib/workflows/types.ts`), and of any other
 * caller that wants ONE environment reconciled on demand.
 *
 * It is `reconcileEnvironment` with the two lookups the core deliberately does
 * not do — who the environment is and what is deployed in it — behind ports,
 * and with the result reduced to what crosses the Temporal boundary: counts
 * only (workflow payloads carry ids, digests and counts, never findings or
 * provider responses).
 *
 * The workflow already holds the `reconcile:<environmentId>` lease and passes
 * it (`fence`); this function does not take a second one. `autoRepair` is the
 * workflow's `allowAutoRepair`: false (the default) observes and reports only,
 * true lets the repair policy PROPOSE repairs through the capability broker —
 * it still never executes one.
 *
 * `drift` counts findings that mean "what exists differs from what is desired"
 * (`missing`, `changed`, `extra`); `unknown` counts findings that mean "Zenith
 * could not tell" (`unknown`, `inaccessible`). Neither is an absence of drift.
 */
import { reconcileEnvironment } from "./core";
import { ReconcileError } from "./errors";
import type { FenceRef, ReconcileEnvironment, ReconcileOptions, ReconcilePorts } from "./types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";

export interface ReconcileOnceDeps {
  ports: ReconcilePorts;
  /** who the environment is; null when it is not known to the controller */
  loadEnvironment(workspaceId: string, environmentId: string): Promise<ReconcileEnvironment | null>;
  /** what is deployed in it; null when nothing is */
  loadGraph(environment: ReconcileEnvironment): Promise<ResourceGraph | null>;
  options?: ReconcileOptions;
}

export interface ReconcileOnceInput {
  workspaceId: string;
  environmentId: string;
  /** the workflow's `allowAutoRepair` (default false) */
  autoRepair?: boolean;
  fence?: FenceRef;
  signal?: AbortSignal;
}

export interface ReconcileOnceResult {
  drift: number;
  unknown: number;
  /** `nothing_to_reconcile` when nothing was deployed or observable */
  status: "reconciled" | "nothing_to_reconcile";
  /** repair proposals submitted to the broker (any outcome) */
  repairsProposed: number;
}

export async function reconcileObserveOnce(input: ReconcileOnceInput, deps: ReconcileOnceDeps): Promise<ReconcileOnceResult> {
  const environment = await deps.loadEnvironment(input.workspaceId, input.environmentId);
  if (!environment || environment.workspaceId !== input.workspaceId)
    throw new ReconcileError("invalid_input", `Environment ${input.environmentId} is not known to the reconciliation controller in this workspace; register it first.`);
  const graph = await deps.loadGraph(environment);
  if (!graph) return { drift: 0, unknown: 0, status: "nothing_to_reconcile", repairsProposed: 0 };

  const result = await reconcileEnvironment({
    environment,
    graph,
    ports: deps.ports,
    options: { ...deps.options, autoRepair: input.autoRepair ?? false },
    ...(input.fence ? { fence: input.fence } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    drift: result.counts.missing + result.counts.changed + result.counts.extra,
    unknown: result.counts.unknown + result.counts.inaccessible,
    status: result.status,
    repairsProposed: result.repairs.filter((r) => r.status === "proposed").length,
  };
}

/**
 * The Temporal `reconcileObserve` activity, ready to register: maps the
 * activity input (`passId`, ids, the held `LeaseRef`) onto `reconcileObserveOnce`
 * and returns exactly `{ drift, unknown }`. The lease must be this environment's
 * `reconcile:<environmentId>` lease; anything else is refused before any read,
 * so a mis-wired workflow cannot reconcile under a lease that protects
 * something else.
 *
 * `allowAutoRepair` is not part of the activity's input today, so this defaults
 * to observe-and-report only; pass `autoRepair: true` in `deps` to let the
 * repair policy PROPOSE repairs from this path too.
 */
export function createReconcileObserveActivity(deps: ReconcileOnceDeps & { autoRepair?: boolean }) {
  return async (input: { passId: string; workspaceId: string; environmentId: string; lease: LeaseRef }): Promise<{ drift: number; unknown: number }> => {
    if (input.lease.scope !== `reconcile:${input.environmentId}`)
      throw new ReconcileError("invalid_input", `The reconcile pass holds lease ${input.lease.scope}, not reconcile:${input.environmentId}; refusing to observe under a lease that protects something else.`);
    const { drift, unknown } = await reconcileObserveOnce(
      { workspaceId: input.workspaceId, environmentId: input.environmentId, autoRepair: deps.autoRepair ?? false, fence: { scope: input.lease.scope, token: input.lease.fenceToken } },
      deps
    );
    return { drift, unknown };
  };
}
