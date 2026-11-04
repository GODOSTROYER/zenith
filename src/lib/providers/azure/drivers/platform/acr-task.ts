/**
 * `azure:acr_task` — portable `build_pipeline` (ADR-0016): source builds run in
 * the CUSTOMER's subscription, in the customer's registry, never in Zenith's
 * process.
 *
 * There is nothing persistent to declare: a build is an ephemeral ACR Tasks
 * RUN scheduled through the registry's `scheduleRun` API (`acr-build.ts`), from
 * a source archive uploaded to a short-lived, registry-owned upload URL. The
 * persistent `azurerm_container_registry_task` resource would need a source
 * access token (a secret, in state) and a trigger Zenith does not want, so it is
 * deliberately not used. `compile` therefore emits an empty fragment after
 * checking the output registry is an Azure registry in this graph.
 *
 * Observation: "present" means the output registry exists (found by its Zenith
 * tags) and so can accept a scheduled run; there is no object for the pipeline
 * itself. The registry's login server is reported for the image reference.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import { AzureCompileError, fragment, requireNode, specOf } from "@/lib/providers/azure/compile-util";
import { defineAzureDriver, locateByTags, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { CONTAINER_REGISTRY } from "@/lib/providers/azure/drivers/platform/container-registry";

export function compileAcrTask(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<BuildPipelineSpec>(node);
  if (!("registry" in spec.output)) throw new AzureCompileError("an Azure build pipeline pushes to a container registry; static-site outputs are not supported on Azure.", node.address);
  const registry = requireNode(ctx, spec.output.registry, "the build's output registry", node.address);
  if (registry.provider !== "azure" || registry.kind !== "container_registry") {
    throw new AzureCompileError(`output ${spec.output.registry} is not an Azure container registry.`, node.address);
  }
  if (spec.location !== "customer_account") throw new AzureCompileError(`builds must run in the customer account (ADR-0016), not "${String(spec.location)}".`, node.address);
  return fragment({});
}

async function locateRegistry(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const spec = specOf<BuildPipelineSpec>(node);
  if (!("registry" in spec.output)) return { state: "unknown", detail: "not a registry output" };
  return locateByTags(ctx, { ...node, address: spec.output.registry } as ResourceNode, CONTAINER_REGISTRY, externalId);
}

export const acrTaskDriver = defineAzureDriver({
  id: "azure.acr_task@1",
  kind: "build_pipeline",
  nativeType: "azure:acr_task",
  locate: locateRegistry,
  compile: compileAcrTask,
  expected: (node) => {
    const spec = specOf<BuildPipelineSpec>(node);
    return { outputRegistry: "registry" in spec.output ? spec.output.registry : undefined, location: "customer_account" };
  },
  read: (res, node) => {
    const spec = specOf<BuildPipelineSpec>(node);
    return {
      // known only because the registry object was actually found and is usable for ACR Tasks
      outputRegistry: pick<string>(props(res), "provisioningState") === "Succeeded" && "registry" in spec.output ? spec.output.registry : undefined,
      location: "customer_account",
    };
  },
  native: (res) => ({ loginServer: props(res).loginServer, provisioningState: props(res).provisioningState }),
});
