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
import { digest } from "@/lib/controlplane/digest";
import type { FenceRef, ReconcileEnvironment, ReconcileOptions, ReconcilePorts } from "./types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ReconcileActivities, ReconcileRepairSummary } from "@/lib/workflows/types";

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
  /** New histories request a count/digest summary; old activity results retain their shape. */
  includeRepairSummary?: boolean;
}

export interface ReconcileOnceResult {
  drift: number;
  unknown: number;
  /** `nothing_to_reconcile` when nothing was deployed or observable */
  status: "reconciled" | "nothing_to_reconcile";
  /** repair proposals submitted to the broker (any outcome) */
  repairsProposed: number;
  repairs?: ReconcileRepairSummary;
}

const emptyRepairs = (): ReconcileRepairSummary => ({ proposed: 0, started: 0, awaitingApproval: 0, denied: 0, blockedUncertain: 0, unsupported: 0, failed: 0, skipped: 0, digest: digest({ repairs: [] }) });

export async function reconcileObserveOnce(input: ReconcileOnceInput, deps: ReconcileOnceDeps): Promise<ReconcileOnceResult> {
  input.signal?.throwIfAborted();
  if (input.fence) await deps.ports.assertFence?.(input.fence);
  const environment = await deps.loadEnvironment(input.workspaceId, input.environmentId);
  if (!environment || environment.workspaceId !== input.workspaceId || environment.environmentId !== input.environmentId)
    throw new ReconcileError("invalid_input", "Environment is not known to the reconciliation controller in this workspace.");
  const graph = await deps.loadGraph(environment);
  input.signal?.throwIfAborted();
  if (!graph) return { drift: 0, unknown: 0, status: "nothing_to_reconcile", repairsProposed: 0, ...(input.includeRepairSummary ? { repairs: emptyRepairs() } : {}) };

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
    ...(input.includeRepairSummary ? { repairs: {
      proposed: result.repairs.filter((r) => r.status === "proposed").length,
      started: result.repairs.filter((r) => r.started === true).length,
      awaitingApproval: result.repairs.filter((r) => r.outcome === "require_approval").length,
      denied: result.repairs.filter((r) => r.outcome === "deny").length,
      blockedUncertain: result.repairs.filter((r) => r.reason === "repair_uncertain").length,
      unsupported: result.repairs.filter((r) => r.reason === "repair_not_supported").length,
      failed: result.repairs.filter((r) => r.status === "failed" || r.started === false).length,
      skipped: result.repairs.filter((r) => r.status === "skipped").length,
      digest: digest({ graphDigest: result.report?.graphDigest ?? null, repairs: result.repairs.map(({ address, class: findingClass, status, outcome, operationId, started, reason }) => ({ address, findingClass, status, outcome, operationId, started, reason })) }),
    } } : {}),
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
 * The request permits broker proposals only. Without the patched request field
 * it remains observe-only and returns the historical two-count result.
 */
export function createReconcileObserveActivity(deps: ReconcileOnceDeps & { signal?: AbortSignal }): ReconcileActivities["reconcileObserve"] {
  return async (input) => {
    if (input.passId !== `reconcile-${input.environmentId}` || input.lease.scope !== `reconcile:${input.environmentId}`)
      throw new ReconcileError("invalid_input", "The reconcile pass does not match its environment or held lease.");
    const { drift, unknown, repairs } = await reconcileObserveOnce(
      { workspaceId: input.workspaceId, environmentId: input.environmentId, autoRepair: input.allowAutoRepair === true, includeRepairSummary: input.allowAutoRepair !== undefined, fence: { scope: input.lease.scope, token: input.lease.fenceToken }, signal: deps.signal },
      deps
    );
    return { drift, unknown, ...(repairs ? { repairs } : {}) };
  };
}
