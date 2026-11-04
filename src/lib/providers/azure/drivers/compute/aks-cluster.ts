/**
 * Private AKS, Azure CNI overlay, OIDC/workload identity, Entra RBAC and no
 * local accounts. The control-plane UAI is customer-prepared with subnet join
 * and regional private DNS permissions: Zenith does not grant
 * subscription-level Network Contributor. The customer prepares both scopes.
 * Node pools are explicit and sized from the spec. ARM provisioned/Running is
 * not Kubernetes node readiness, which requires a separate Kubernetes session.
 * No kubeconfig, cluster credential LIST action or SSH key is ever read.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { block, fragment, mergeBlocks, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { armTemplate } from "@/lib/providers/azure/drivers/arm-template";
import { defineAzureDriver, props, pick } from "@/lib/providers/azure/kit";
import { armIdSpec, boolSpec, integerSpec, invalid, privateSubnet, readBool, readString, readNumber, rejectCredentials, textSpec } from "@/lib/providers/azure/drivers/more-util";
import { isPrivateCidr, parseCidr } from "@/lib/providers/azure/platform";

export const AKS = { type: "Microsoft.ContainerService/managedClusters", apiVersion: "2024-10-01" } as const;
interface Pool { name: string; vmSize: string; count: number; osDiskSizeGb: number }

function pools(node: ResourceNode): Pool[] {
  const input = node.spec.nodePools ?? [{ name: "system", vmSize: node.spec.instanceClass ?? "Standard_D2s_v5", count: node.spec.nodeCount ?? 2, osDiskSizeGb: 128 }];
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) invalid(node, "nodePools must contain between one and ten pools.");
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== "object") invalid(node, "invalid node pool.");
    const p = raw as Record<string, unknown>;
    const n = { ...node, spec: p };
    const name = textSpec(n, "name");
    const vmSize = textSpec(n, "vmSize");
    if (!/^[a-z][a-z0-9]{0,11}$/.test(name) || seen.has(name)) invalid(node, "node pool names must be unique lowercase alphanumeric names of at most 12 characters.");
    if (!/^Standard_[A-Za-z0-9_]+$/.test(vmSize)) invalid(node, "node pool vmSize must be an Azure Standard SKU.");
    seen.add(name);
    return { name, vmSize, count: integerSpec(n, "count", 2, 1, 100), osDiskSizeGb: integerSpec(n, "osDiskSizeGb", 128, 30, 2048) };
  });
}

function cidrs(node: ResourceNode, vnetCidr: string) {
  const service = textSpec(node, "serviceCidr", "172.20.0.0/16");
  const pod = textSpec(node, "podCidr", "172.21.0.0/16");
  const ranges = [service, pod, vnetCidr].map((value) => parseCidr(value, node.address));
  if (![service, pod].every(isPrivateCidr) || ranges.slice(0, 2).some((r) => r.bits > 24 || r.bits < 8)) invalid(node, "serviceCidr and podCidr must be private /8 through /24 ranges.");
  const overlaps = (i: number, j: number) => ranges[i].base < ranges[j].base + 2 ** (32 - ranges[j].bits) && ranges[j].base < ranges[i].base + 2 ** (32 - ranges[i].bits);
  if (overlaps(0, 1) || overlaps(0, 2) || overlaps(1, 2)) invalid(node, "AKS service, pod and VNet CIDRs must not overlap.");
  const ip = ranges[0].base + 10;
  const dns = [24, 16, 8, 0].map((shift) => Math.floor(ip / 2 ** shift) % 256).join(".");
  return { service, pod, dns };
}

export const aksClusterDriver = defineAzureDriver({
  id: "azure.aks_cluster@1", kind: "kubernetes_cluster", nativeType: "azure:aks_cluster", arm: AKS,
  compile: (node, ctx) => {
    rejectCredentials(node);
    if (!boolSpec(node, "privateCluster", true) || node.spec.authorizedIpRanges !== undefined) invalid(node, "only private API servers are supported; authorized public API ranges are not used.");
    const subnet = privateSubnet(node, ctx);
    const net = resolveNetwork(subnet, ctx);
    const network = ctx.node(net)!;
    const identity = armIdSpec(node, "controlPlaneIdentityId", "Microsoft.ManagedIdentity/userAssignedIdentities");
    const ranges = cidrs(node, String(network.spec.cidr));
    const ps = pools(node);
    const L = (p: string) => tfLabel(node.address, p);
    const tags = azureTags(ctx, node);
    const version = node.spec.version === undefined ? undefined : textSpec(node, "version");
    if (version !== undefined && !/^1\.[0-9]{2}(?:\.[0-9]+)?$/.test(version)) invalid(node, "version must be a Kubernetes 1.x version.");
    const poolBlock = (p: Pool) => ({ name: p.name, vm_size: p.vmSize, node_count: p.count, os_disk_size_gb: p.osDiskSizeGb, vnet_subnet_id: exportRef(subnet.address, "id"), tags });
    const cluster = armTemplate(node, ctx, net, {
      type: AKS.type, apiVersion: AKS.apiVersion, name: cloudName(ctx, node.address, { max: 63, suffix: "aks" }), tags,
      identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } }, hostnameProperty: "privateFQDN",
      properties: {
        dnsPrefix: cloudName(ctx, node.address, { max: 54 }), ...(version ? { kubernetesVersion: version } : {}),
        apiServerAccessProfile: { enablePrivateCluster: true, enablePrivateClusterPublicFQDN: false, privateDNSZone: armIdSpec(node, "privateDnsZoneId", "Microsoft.Network/privateDnsZones"), disableRunCommand: true },
        disableLocalAccounts: true, enableRBAC: true, aadProfile: { managed: true, tenantID: exportRef(net, "tenant_id"), enableAzureRBAC: true },
        oidcIssuerProfile: { enabled: true }, securityProfile: { workloadIdentity: { enabled: true } },
        agentPoolProfiles: [{ name: ps[0].name, vmSize: ps[0].vmSize, count: ps[0].count, osDiskSizeGB: ps[0].osDiskSizeGb, vnetSubnetID: exportRef(subnet.address, "id"), type: "VirtualMachineScaleSets", mode: "System", osType: "Linux", maxPods: 110, tags }],
        networkProfile: { networkPlugin: "azure", networkPluginMode: "overlay", networkPolicy: "azure", serviceCidr: ranges.service, podCidr: ranges.pod, dnsServiceIP: ranges.dns, loadBalancerSku: "standard", outboundType: "loadBalancer" },
      },
    });
    return fragment({ resource: mergeBlocks(
      cluster.resource,
      ...ps.slice(1).map((p) => block("azurerm_kubernetes_cluster_node_pool", L(`pool_${p.name}`), { ...poolBlock(p), kubernetes_cluster_id: cluster.id, mode: "User" }))
    ), locals: exportLocals(node.address, { id: cluster.id, name: cluster.name, fqdn: cluster.fqdn }) });
  },
  expected: (node) => ({ privateCluster: true, localAccountsDisabled: true, oidcEnabled: true, workloadIdentityEnabled: true, networkPlugin: "azure", networkPluginMode: "overlay", identityType: "UserAssigned", azureRbac: true, nodePools: pools(node).map((p) => ({ name: p.name, count: p.count, vmSize: p.vmSize, osDiskSizeGb: p.osDiskSizeGb })).sort((a, b) => a.name.localeCompare(b.name, "en")) }),
  read: (res) => {
    const raw = props(res).agentPoolProfiles;
    const ps = Array.isArray(raw) ? raw.map((item) => {
      const p = item as Record<string, unknown>;
      return { name: readString(p?.name), count: readNumber(p?.count), vmSize: readString(p?.vmSize), osDiskSizeGb: readNumber(p?.osDiskSizeGB) };
    }) : undefined;
    return { privateCluster: readBool(pick(props(res), "apiServerAccessProfile", "enablePrivateCluster")), localAccountsDisabled: readBool(props(res).disableLocalAccounts), oidcEnabled: readBool(pick(props(res), "oidcIssuerProfile", "enabled")), workloadIdentityEnabled: readBool(pick(props(res), "securityProfile", "workloadIdentity", "enabled")), networkPlugin: readString(pick(props(res), "networkProfile", "networkPlugin")), networkPluginMode: readString(pick(props(res), "networkProfile", "networkPluginMode")), identityType: readString(res.identity?.type), azureRbac: readBool(pick(props(res), "aadProfile", "enableAzureRBAC")), nodePools: ps?.every((p) => Object.values(p).every((v) => v !== undefined)) ? ps.sort((a, b) => a.name!.localeCompare(b.name!, "en")) : undefined };
  },
  runtime: async (_ctx, _node, res) => ({ health: props(res).provisioningState === "Failed" || pick(props(res), "powerState", "code") === "Stopped" ? "unhealthy" : "unknown", counts: {}, signals: ["kubernetes_node_readiness_not_inspected"] }),
  serving: true,
  native: (res) => ({ provisioningState: props(res).provisioningState, powerState: pick(props(res), "powerState", "code") }),
});
