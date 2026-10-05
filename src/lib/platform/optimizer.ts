/**
 * Production composition of the scheduled optimizer pass (PROD-COST-03).
 *
 * Reuses the reconcile sweep's already-composed ports (environment lookup,
 * applied graph, environment guard) and its canonical broker, so the optimizer
 * runs with the same authority boundary: it can only PROPOSE through the
 * broker, and policy and human approval decide.
 *
 * Two inputs are deliberately conservative until their sources exist:
 * - measurements: no usage/utilization collector is wired here, so the default
 *   port reports "no measurements" and every environment is skipped and
 *   counted. Provide an `OptimizerMeasurementPort` to enable optimization.
 * - field ownership: the registry (PROD-LIFE-12) is not wired, so ownership is
 *   unknown and every change is refused. Provide a `FieldOwnershipCheck`.
 */
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import type { Broker } from "@/lib/capabilities/platform";
import { listOptedInEnvironments } from "@/lib/controlplane/db/repos/optimizer-settings";
import type { Sql } from "@/lib/controlplane/types";
import { refuseUnknownFieldOwnership, type FieldOwnershipCheck } from "@/lib/placement/optimizer";
import type { OptimizerMeasurementPort, OptimizerPassPorts } from "@/lib/platform/optimizer-pass";
import type { ReconcilePassPorts } from "@/lib/reconcile/pass-types";

export const noMeasurements: OptimizerMeasurementPort = { load: async () => undefined };

export interface ComposeOptimizerOptions {
  measurements?: OptimizerMeasurementPort;
  ownership?: FieldOwnershipCheck;
}

export function composeOptimizerPorts(db: Sql, reconcile: ReconcilePassPorts, broker: Broker, options: ComposeOptimizerOptions = {}): OptimizerPassPorts {
  const catalog = loadDefaultCatalog();
  return {
    listOptedIn: (limit) => listOptedInEnvironments(db, limit),
    loadEnvironment: async (workspaceId, environmentId) => (reconcile.loadEnvironment ? reconcile.loadEnvironment(workspaceId, environmentId) : null),
    loadGraph: (environment) => reconcile.loadGraph(environment),
    guard: reconcile.guard,
    measurements: options.measurements ?? noMeasurements,
    async resources(environment) {
      const rows = await db.query<{ id: string; address: string; origin: unknown }>(
        "select id, address, origin from platform.resources where workspace_id = $1 and environment_id = $2 and kind = 'container_service' and ownership = 'managed' and status <> 'deleted'",
        [environment.workspaceId, environment.environmentId],
      );
      const out = new Map<string, { resourceId: string; serviceId: string }>();
      for (const r of rows) {
        const serviceId = Array.isArray(r.origin) && typeof r.origin[0] === "string" ? r.origin[0] : undefined;
        if (serviceId) out.set(r.address, { resourceId: r.id, serviceId });
      }
      return out;
    },
    ownership: options.ownership ?? refuseUnknownFieldOwnership,
    store: broker.deps.store,
    broker,
    catalog,
    now: () => new Date(),
  };
}
