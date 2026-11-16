/**
 * One scheduled optimizer pass (PROD-COST-03).
 *
 * Runs inside the existing durable reconcile sweep (see
 * `workflows/reconcile-schedule.ts`), under its lease, so it survives worker
 * restarts and is never run by a second process at once. It is OFF per tenant
 * environment until a human opts in (`platform.optimizer_settings`, default
 * disabled). For each opted-in environment it:
 *
 *   1. takes the environment guard (the same mutual exclusion the reconciler
 *      uses, so it never optimizes mid-deploy);
 *   2. loads the applied graph and the MEASURED usage and utilization;
 *   3. rebuilds cooldown / reversal / window history from the durable
 *      `service.scale` operation records, not from memory;
 *   4. runs the pure optimizer restricted to what `service.scale` can carry;
 *   5. proposes each result through the capability broker.
 *
 * It never approves, never starts an execution and never calls a cloud. An
 * environment with no measurements is skipped and counted, never optimized on
 * defaults. A failure in one environment is counted and does not stop the rest.
 */
import type { BrokerStore } from "@/lib/capabilities/ports";
import type { Principal } from "@/lib/controlplane/types";
import type { EnvironmentGuard } from "@/lib/reconcile/pass-types";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import type { ResourceGraph } from "@/lib/resources/types";
import { historyFromOperations, loadScaleOperations } from "@/lib/placement/optimizer-history";
import { DEFAULT_OPTIMIZER_POLICY, optimizeEconomics, type FieldOwnershipCheck, type MeasuredUsage, type MeasuredUtilization, type OptimizerPolicy } from "@/lib/placement/optimizer";
import { submitOptimizationProposals, type ProposalBroker } from "@/lib/placement/optimizer-submit";
import type { PlacementConstraints, PriceCatalog } from "@/lib/placement/types";

/** The system identity on optimizer proposals. Never a person, never an approver. */
export const OPTIMIZER_PRINCIPAL: Principal = { kind: "system", id: "optimizer", name: "Zenith economic optimizer" };

export interface EnvironmentMeasurements {
  measured: MeasuredUsage;
  utilization: Record<string, MeasuredUtilization>;
  constraints: PlacementConstraints;
}

/** Where measurements come from. Returns undefined when there are none (the environment is then skipped). */
export interface OptimizerMeasurementPort {
  load(environment: ReconcileEnvironment, graph: ResourceGraph, signal?: AbortSignal): Promise<EnvironmentMeasurements | undefined>;
}

export interface OptimizerPassPorts {
  listOptedIn(limit: number): Promise<{ workspaceId: string; environmentId: string }[]>;
  loadEnvironment(workspaceId: string, environmentId: string): Promise<ReconcileEnvironment | null>;
  loadGraph(environment: ReconcileEnvironment): Promise<ResourceGraph | null>;
  guard: EnvironmentGuard;
  measurements: OptimizerMeasurementPort;
  /** graph address -> platform resource id and manifest service id */
  resources(environment: ReconcileEnvironment): Promise<ReadonlyMap<string, { resourceId: string; serviceId: string }>>;
  ownership: FieldOwnershipCheck;
  store: Pick<BrokerStore, "listOperations">;
  broker: ProposalBroker;
  principal?: Principal;
  catalog: PriceCatalog;
  now(): Date;
  policy?: Partial<OptimizerPolicy>;
}

export interface OptimizerPassResult {
  environments: number;
  proposed: number;
  refused: number;
  skipped: number;
  noMeasurements: number;
  busy: number;
  failed: number;
}

export interface OptimizerPassOptions {
  maxEnvironments?: number;
  signal?: AbortSignal;
}

export async function runOptimizerPass(ports: OptimizerPassPorts, options: OptimizerPassOptions = {}): Promise<OptimizerPassResult> {
  const result: OptimizerPassResult = { environments: 0, proposed: 0, refused: 0, skipped: 0, noMeasurements: 0, busy: 0, failed: 0 };
  const policy = { ...DEFAULT_OPTIMIZER_POLICY, ...(ports.policy ?? {}) };
  const targets = await ports.listOptedIn(options.maxEnvironments ?? 25);
  for (const target of targets) {
    options.signal?.throwIfAborted();
    try {
      const environment = await ports.loadEnvironment(target.workspaceId, target.environmentId);
      if (!environment || !environment.projectId) {
        result.skipped++;
        continue;
      }
      result.environments++;
      const guarded = await ports.guard.run(environment, async (held) => {
        const signal = held.signal ?? options.signal;
        signal?.throwIfAborted();
        const graph = await ports.loadGraph(environment);
        if (!graph) return "skipped" as const;
        const m = await ports.measurements.load(environment, graph, signal);
        if (!m) return "no_measurements" as const;
        const resources = await ports.resources(environment);
        const byResource = new Map([...resources].map(([address, r]) => [r.resourceId, address]));
        const now = ports.now();
        const since = new Date(now.getTime() - Math.max(policy.cooldownMs, policy.reversalLockoutMs, policy.windowMs)).toISOString();
        const ops = await loadScaleOperations(ports.store, environment.workspaceId, environment.environmentId, since);
        const history = historyFromOperations(ops, (id) => byResource.get(id));
        signal?.throwIfAborted();
        const run = await optimizeEconomics({
          graph,
          catalog: ports.catalog,
          constraints: m.constraints,
          measured: m.measured,
          utilization: m.utilization,
          history,
          policy: ports.policy,
          ownership: ports.ownership,
          routableOnly: true,
          now: now.toISOString(),
        });
        if (run.proposals.length === 0) return "none" as const;
        signal?.throwIfAborted();
        const out = await submitOptimizationProposals(run.proposals, {
          broker: ports.broker,
          principal: ports.principal ?? OPTIMIZER_PRINCIPAL,
          scope: { workspaceId: environment.workspaceId, projectId: environment.projectId!, environmentId: environment.environmentId },
          serviceIdFor: (a) => resources.get(a)?.serviceId,
          resourceIdFor: (a) => resources.get(a)?.resourceId,
          now: now.toISOString(),
        });
        result.proposed += out.submitted.filter((s) => !s.replayed).length;
        result.refused += out.refused.length;
        return "done" as const;
      });
      if (!guarded.ran) result.busy++;
      else if (guarded.value === "no_measurements") result.noMeasurements++;
      else if (guarded.value === "skipped") result.skipped++;
    } catch (e) {
      if (options.signal?.aborted) throw e;
      result.failed++;
    }
  }
  return result;
}
