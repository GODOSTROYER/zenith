import type { ObservabilityPort, ProjectReads } from "@/lib/agent-access/v3/ports";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import type { Broker } from "@/lib/capabilities/platform";
import { OPTIMIZER_PRINCIPAL } from "@/lib/platform/optimizer-pass";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import type { MeasurementCollectorDeps } from "./measurement-collector";
import { ManifestPolicies } from "@/lib/domain/types";
import { upgradeManifest } from "@/lib/resources/upgrade";

/** The collector uses the same broker authorization and scoped fabric as REST/MCP reads. */
export function createMeasurementDeps(broker: Broker, observability: ObservabilityPort, reads: ProjectReads, now: () => Date): MeasurementCollectorDeps {
  async function environmentFor(env: ReconcileEnvironment) {
    if (!env.projectId) throw notFound();
    const current = await reads.environment(env.workspaceId, env.projectId, env.environmentId);
    if (!current || current.id !== env.environmentId || current.projectId !== env.projectId) throw notFound();
    return current;
  }
  return { now,
    async read(env, graph, query, signal) {
      signal?.throwIfAborted();
      if (graph.environmentId !== env.environmentId || query.scope.workspaceId !== env.workspaceId || query.scope.environmentId !== env.environmentId || query.scope.projectId !== env.projectId) throw notFound();
      const current = await environmentFor(env);
      signal?.throwIfAborted();
      const authorized = await broker.authorizeRead({ capability: "metrics.read", scope: { workspaceId: env.workspaceId, projectId: env.projectId, environmentId: env.environmentId } }, OPTIMIZER_PRINCIPAL, { ctx: { via: "workflow" } });
      if (authorized.decision.outcome !== "allow" || !authorized.claims) throw new BrokerError("policy_denied", "Current policy does not allow optimizer measurements.");
      return observability.withFabric({ workspaceId: env.workspaceId, environment: current, graph, grant: authorized.claims, purpose: "cost" }, fabric => fabric.queryMetrics(query, signal));
    },
    async constraints(env) {
      const current = await environmentFor(env);
      if (!current.deployedRevisionId) throw new BrokerError("invalid_state", "Optimizer constraints require an applied revision.");
      const revision = await reads.revision(env.workspaceId, current.projectId, current.deployedRevisionId);
      if (!revision || revision.id !== current.deployedRevisionId || revision.projectId !== current.projectId) throw notFound();
      const legacy = ManifestPolicies.strict().safeParse(current.policies);
      if (revision.manifest.version === 1 && !legacy.success) throw new BrokerError("invalid_state", "Applied V1 constraints require unambiguous current environment policies.");
      // A pure read view only: preserve V1 in storage and carry its authoritative environment budget.
      const manifest = revision.manifest.version === 2 ? revision.manifest
        : upgradeManifest(revision.manifest, { provider: "auto", policies: legacy.success ? legacy.data : undefined });
      const budgets = [manifest.constraints?.budgetUsdMonthly, legacy.success ? legacy.data.budgetUsdMonthly : undefined].filter((n): n is number => n !== undefined);
      return { ...manifest.constraints, userRegions: manifest.constraints?.userRegions ?? [],
        ...(budgets.length ? { budgetUsdMonthly: Math.min(...budgets) } : {}),
        residency: manifest.placement?.residency, tolerateSingleFailure: !!(manifest.constraints?.tolerateSingleFailure || (manifest.placement?.zones ?? 1) > 1) };
    },
  };
}
