/** Managed declarative semantics, including current domain proof and operator policy. */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderConnection } from "@/lib/credentials/types";
import type { ManagedSubstratePort, TenantRef } from "@/lib/providers/zenith/managed-port";
import { planLimits } from "@/lib/providers/zenith/plans";
import { renderZenithEnvironment, ZENITH_BOOTSTRAP_IMAGE } from "@/lib/providers/zenith/render";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { CollectArgs } from "./collect";
import { MANAGED_APPLY_CONTRACT } from "./direct";
import { prepareIsolation } from "../tenant-isolation";
import { isolationExecutableSemantics } from "@/lib/providers/zenith/onboarding";

export async function zenithSemanticsArgs(managed: ManagedSubstratePort, tenantRef: TenantRef, graph: ResourceGraph, connection: Pick<ProviderConnection, "id" | "config">, planDigest: string): Promise<CollectArgs & { planDigest: string }> {
  const tenant = await managed.tenants.resolve(tenantRef);
  const substrate = managed.substrate();
  const serving = await managed.servingInputs?.(tenantRef) ?? { verifiedDomains: [], retiredDomains: [] };
  const builtImages: Record<string, string> = {};
  for (const node of graph.nodes) {
    const artifact = node.spec.artifact as ArtifactSpec | undefined;
    if (artifact?.type === "built") builtImages[artifact.pipeline] = ZENITH_BOOTSTRAP_IMAGE;
  }
  const rendered = renderZenithEnvironment({ tenant, substrate, nodes: graph.nodes, toolkit: managed.toolkit, builtImages,
    verifiedDomains: serving.verifiedDomains, autoscaling: planLimits(tenant.planTier).maxAutoscaleReplicas > 0 });
  const request = managed.onboarding?.request(tenant, "semantics", { scope: `env:${tenant.environmentId}`, fenceToken: 1 }, rendered.databases.length > 0);
  const isolation = request ? prepareIsolation(request) : undefined;
  const onboardingSemantics = request && isolation ? isolationExecutableSemantics(request, { planDigest: "0".repeat(64), bundleDigest: isolation.bundleDigest, namespace: isolation.namespace }).digest : null;
  return {
    graph, connection: { id: connection.id, config: connection.config }, planDigest, engineVersion: MANAGED_APPLY_CONTRACT,
    ws: { files: [], backend: "local", lockDigest: digest({ provider: "zenith", contract: "Z1" }),
      configDigest: digest({ engine: MANAGED_APPLY_CONTRACT, graphDigest: graph.graphDigest, tenant, substrate,
        objects: [...rendered.baseline, ...rendered.workloads], platformTls: rendered.platformTls,
        isolation: rendered.isolation, onboardingSemantics, databases: rendered.databases, storage: rendered.storage, retiredDomains: serving.retiredDomains }) },
  };
}
