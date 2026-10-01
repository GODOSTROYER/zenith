/** Exact AKS federation contracts; no kubeconfig or live Azure API reads. */
import { describe, expect, it } from "vitest";
import { compileIdentity } from "@/lib/providers/azure/drivers/identity/identity";
import { exportName, exportRef } from "@/lib/providers/azure/exports";
import { renderIdentity } from "@/lib/providers/kubernetes/renderers/identity";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { mkNode, compileContext, graphOf, SUB } from "../_helpers";

function fixture() {
  const network = mkNode("network/main", "network", "azure:virtual_network", {});
  const account = mkNode("identity/kube.web", "identity", "k8s:ServiceAccount", { workload: "service/web", grants: [], namespace: "orders" }, { provider: "kubernetes" });
  const workload = mkNode("service/web", "container_service", "k8s:Deployment", { namespace: "orders" }, { provider: "kubernetes", dependsOn: [account.address, "cluster/main"] });
  const cluster = mkNode("cluster/main", "kubernetes_cluster", "azure:aks_cluster", {}, { dependsOn: [network.address] });
  const identity = mkNode("identity/cloud", "identity", "azure:user_assigned_identity", { principal: "workload", workload: workload.address, grants: [] }, { dependsOn: [network.address] });
  return { network, account, workload, cluster, identity, nodes: [network, account, workload, cluster, identity] };
}
describe("AKS ServiceAccount federation", () => {
  it("pins the renderer's subject, AKS issuer and token-exchange audience on the UAI", () => {
    const f = fixture(); const ctx = compileContext(f.nodes); const fragment = compileIdentity(f.identity, ctx);
    const sa = renderIdentity(f.account, { environmentId: ctx.environmentId, node: ctx.node }).objects[0];
    const binding = Object.values(fragment.resource!.azurerm_federated_identity_credential)[0];
    expect(binding).toMatchObject({ user_assigned_identity_id: expect.stringMatching(/^\$\{azurerm_user_assigned_identity\..*\.id\}$/), subject: `system:serviceaccount:${sa.metadata.namespace}:${sa.metadata.name}`, audience: ["api://AzureADTokenExchange"], issuer: expect.stringContaining(".output_content).issuer.value") });
    expect(binding).not.toHaveProperty("parent_id");
    expect(binding).not.toHaveProperty("resource_group_name");
    const issuer = Object.values(fragment.resource!.azurerm_resource_group_template_deployment)[0];
    expect(JSON.parse(issuer.parameters_content as string)).toEqual({ clusterId: { value: exportRef(f.cluster.address, "id") } });
    const template = JSON.parse(issuer.template_content as string);
    expect(template.resources).toEqual([]);
    expect(template.outputs.issuer.value).toBe("[reference(parameters('clusterId'), '2024-10-01').oidcIssuerProfile.issuerURL]");
    expect(JSON.stringify(fragment)).not.toMatch(/listCluster|kubeconfig|client_secret|\*/i);
    expect(compileIdentity(f.identity, compileContext([...f.nodes].reverse()))).toEqual(fragment);
  });
  it.each(["referenced", "external"] as const)("emits no federation for a %s cluster", (ownership) => {
    const f = fixture(); f.cluster.ownership = ownership;
    const result = compileIdentity(f.identity, compileContext(f.nodes));
    expect(result.resource!.azurerm_federated_identity_credential).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("customer-managed trust");
  });
  it("keeps the UAI but only notes an absent cluster", () => {
    const f = fixture(); f.identity.spec.cluster = f.cluster.address;
    const result = compileIdentity(f.identity, compileContext(f.nodes.filter((n) => n !== f.cluster)));
    expect(result.resource!.azurerm_user_assigned_identity).toBeDefined();
    expect(result.resource!.azurerm_federated_identity_credential).toBeUndefined();
    expect(result.output).toBeDefined();
  });
});
describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("AKS trust pinned provider schema", () => {
  it("validates the new federation and issuer-only deployment with real tofu", async () => {
    const f = fixture(); const fragment = compileIdentity(f.identity, compileContext(f.nodes));
    Object.assign(fragment.locals!, { [exportName(f.network.address, "rg_name")]: "contract-rg", [exportName(f.cluster.address, "id")]: `/subscriptions/${SUB}/resourceGroups/contract-rg/providers/Microsoft.ContainerService/managedClusters/contract-aks` });
    const ws = assembleWorkspace({ graph: graphOf(f.nodes), fragments: new Map([[f.identity.address, fragment]]), providerSet: "azure", region: "westeurope", backend: { kind: "local", path: "terraform.tfstate" }, tags: {}, providerConfig: { azurerm: { subscription_id: SUB, resource_provider_registrations: "none", storage_use_azuread: true } } });
    await new TofuRunner({ limits: { timeoutMs: 600_000 } }).run(ws, {}, async (run) => {
      const init = await run.init(); expect(init.exitCode, init.output).toBe(0);
      const validation = await run.validate(); expect(validation.result.exitCode, validation.result.output).toBe(0);
    });
  }, 900_000);
});
