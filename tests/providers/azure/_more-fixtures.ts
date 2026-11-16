/** Explicit graph and fake ARM documents for the additional drivers: contract evidence only. */
import type { ResourceNode } from "@/lib/resources/types";
import { mkNode, sampleGraph, SUB } from "./_helpers";
import { World } from "./_world";

export const preparedIdentity = `/subscriptions/${SUB}/resourceGroups/customer/providers/Microsoft.ManagedIdentity/userAssignedIdentities/directory-reader`;
export const preparedZone = `/subscriptions/${SUB}/resourceGroups/customer/providers/Microsoft.Network/privateDnsZones/privatelink.3.azurestaticapps.net`;
const wireString = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
// Public-only RSA fixture. No corresponding private key exists or is needed by these tests.
export const sshPublicKey = `ssh-rsa ${Buffer.concat([wireString(Buffer.from("ssh-rsa")), wireString(Buffer.from([1, 0, 1])), wireString(Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 255)]))]).toString("base64")}`;

export function moreGraph(): ResourceNode[] {
  const nodes = sampleGraph();
  nodes.push(
    mkNode("subnet/mysql", "subnet", "azure:subnet", { tier: "private", zone: "a", network: "network/main", cidr: "10.0.30.0/26", role: "mysql" }),
    mkNode("subnet/functions", "subnet", "azure:subnet", { tier: "private", zone: "a", network: "network/main", cidr: "10.0.31.0/24", role: "functions" }),
    mkNode("compute_instance/machine", "compute_instance", "azure:virtual_machine", { subnet: "subnet/private-a", size: "standard", adminSshPublicKey: sshPublicKey }, { dependsOn: ["network/main", "subnet/private-a", "identity/machine"] }),
    mkNode("volume/data", "volume", "azure:managed_disk", { sizeGb: 64, storageClass: "Premium_LRS" }, { dependsOn: ["network/main"] }),
    mkNode("function/worker", "function", "azure:function_app", { subnet: "subnet/functions", artifact: { type: "image", ref: "mcr.microsoft.com/azure-functions/node:4-node22" }, env: [{ key: "SESSION_KEY", secretRef: "vault:ws_1/env_azure_1/SESSION_KEY" }] }, { dependsOn: ["network/main", "subnet/functions", "identity/function", "secret/session-key-1a2b3c4d"] }),
    mkNode("static_site/docs", "static_site", "azure:static_web_app", { privateDnsZoneId: preparedZone, artifact: { type: "built", pipeline: "build_pipeline/docs" } }, { dependsOn: ["network/main", "identity/site"] }),
    mkNode("kubernetes_cluster/cluster", "kubernetes_cluster", "azure:aks_cluster", { subnet: "subnet/private-a", controlPlaneIdentityId: preparedIdentity, privateDnsZoneId: preparedZone.replace("privatelink.3.azurestaticapps.net", "privatelink.westeurope.azmk8s.io"), nodePools: [{ name: "system", vmSize: "Standard_D2s_v5", count: 2, osDiskSizeGb: 128 }, { name: "workers", vmSize: "Standard_D4s_v5", count: 3, osDiskSizeGb: 128 }] }, { dependsOn: ["network/main", "subnet/private-a"] }),
    mkNode("mysql/db", "mysql", "azure:mysql_flexible_server", { size: "standard", version: "8.0", highAvailability: true, backup: "daily", createMode: "PointInTimeRestore", restoreTime: "2026-09-30T12:00:00Z", sourceServerId: `/subscriptions/${SUB}/resourceGroups/customer/providers/Microsoft.DBforMySQL/flexibleServers/source`, entraIdentityId: preparedIdentity, entraAdministratorId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", entraAdministratorLogin: "database-admin", subnet: "subnet/mysql" }, { dependsOn: ["network/main", "subnet/mysql"] }),
    mkNode("identity/machine", "identity", "azure:user_assigned_identity", { principal: "workload", workload: "compute_instance/machine", grants: [] }, { dependsOn: ["network/main"] }),
    mkNode("identity/function", "identity", "azure:user_assigned_identity", { principal: "workload", workload: "function/worker", grants: [{ target: "secret/session-key-1a2b3c4d", access: ["read"], via: ["env:SESSION_KEY"] }] }, { dependsOn: ["network/main"] }),
    mkNode("identity/site", "identity", "azure:user_assigned_identity", { principal: "workload", workload: "static_site/docs", grants: [] }, { dependsOn: ["network/main"] }),
    mkNode("dns_record/docs.example.com", "dns_record", "azure:dns_record_set", { name: "docs.example.com", type: "alias", target: "static_site/docs", zone: "dns_zone/example.com" }, { dependsOn: ["dns_zone/example.com", "static_site/docs"] }),
    mkNode("firewall/function-to-mysql", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 3306, source: { address: "function/worker" }, target: "mysql/db", capability: "sql", description: "Function to private MySQL" }, { dependsOn: ["mysql/db", "function/worker", "network/main"] }),
  );
  return nodes;
}

export const MORE_ADDRESSES = ["compute_instance/machine", "volume/data", "function/worker", "static_site/docs", "kubernetes_cluster/cluster", "mysql/db"];

export function moreWorld(nodes: ResourceNode[]) {
  const world = new World();
  const ids: Record<string, string> = {};
  const n = (address: string) => nodes.find((item) => item.address === address)!;
  ids["compute_instance/machine"] = world.add("Microsoft.Compute/virtualMachines", ["machine"], { identity: { type: "UserAssigned" }, properties: { provisioningState: "Succeeded", hardwareProfile: { vmSize: "Standard_D2s_v5" }, osProfile: { linuxConfiguration: { disablePasswordAuthentication: true } }, storageProfile: { osDisk: { managedDisk: { storageAccountType: "Premium_LRS" } } } } }, n("compute_instance/machine"));
  const nic = world.add("Microsoft.Network/networkInterfaces", ["machine-nic"], { properties: { ipConfigurations: [{ properties: { privateIPAddress: "10.20.10.10" } }] } });
  const nsg = world.add("Microsoft.Network/networkSecurityGroups", ["machine-nsg"], { properties: { securityRules: [{ name: "deny-ssh", properties: { direction: "Inbound", access: "Deny", priority: 100, protocol: "*", sourceAddressPrefix: "*", destinationAddressPrefix: "*", sourcePortRange: "*", destinationPortRange: "22" } }] } });
  world.patch(nic, (doc) => (doc.properties as Record<string, unknown>).networkSecurityGroup = { id: nsg });
  world.patch(ids["compute_instance/machine"], (doc) => (doc.properties as Record<string, unknown>).networkProfile = { networkInterfaces: [{ id: nic }] });
  world.set(`${ids["compute_instance/machine"]}/instanceView`, { statuses: [{ code: "PowerState/running" }] });
  ids["volume/data"] = world.add("Microsoft.Compute/disks", ["data"], { sku: { name: "Premium_LRS" }, properties: { provisioningState: "Succeeded", diskSizeGB: 64, encryption: { type: "EncryptionAtRestWithPlatformKey" }, networkAccessPolicy: "DenyAll", publicNetworkAccess: "Disabled" } }, n("volume/data"));
  ids["function/worker"] = world.add("Microsoft.Web/sites", ["worker"], { kind: "functionapp,linux,container", identity: { type: "UserAssigned", userAssignedIdentities: { [preparedIdentity]: {} } }, properties: { provisioningState: "Succeeded", state: "Running", httpsOnly: true, publicNetworkAccess: "Disabled", virtualNetworkSubnetId: "/private/subnet", keyVaultReferenceIdentity: preparedIdentity } }, n("function/worker"));
  Object.assign(world.tagged.find((t) => t.id === ids["function/worker"])!, { kind: "functionapp,linux,container" });
  ids["static_site/docs"] = world.add("Microsoft.Web/staticSites", ["docs"], { sku: { name: "Standard" }, identity: { type: "UserAssigned" }, properties: { provisioningState: "Succeeded", publicNetworkAccess: "Disabled", defaultHostname: "docs.3.azurestaticapps.net" } }, n("static_site/docs"));
  ids["kubernetes_cluster/cluster"] = world.add("Microsoft.ContainerService/managedClusters", ["cluster"], { identity: { type: "UserAssigned" }, properties: { provisioningState: "Succeeded", powerState: { code: "Running" }, apiServerAccessProfile: { enablePrivateCluster: true }, disableLocalAccounts: true, oidcIssuerProfile: { enabled: true }, securityProfile: { workloadIdentity: { enabled: true } }, aadProfile: { enableAzureRBAC: true }, networkProfile: { networkPlugin: "azure", networkPluginMode: "overlay" }, agentPoolProfiles: [{ name: "workers", vmSize: "Standard_D4s_v5", count: 3, osDiskSizeGB: 128 }, { name: "system", vmSize: "Standard_D2s_v5", count: 2, osDiskSizeGB: 128 }] } }, n("kubernetes_cluster/cluster"));
  ids["mysql/db"] = world.add("Microsoft.DBforMySQL/flexibleServers", ["db"], { sku: { name: "Standard_D2ds_v4" }, properties: { provisioningState: "Succeeded", state: "Ready", version: "8.0.21", storage: { storageSizeGB: 64 }, highAvailability: { mode: "ZoneRedundant", state: "Healthy" }, backup: { backupRetentionDays: 14, geoRedundantBackup: "Disabled" }, network: { publicNetworkAccess: "Disabled" } } }, n("mysql/db"));
  for (const config of ["aad_auth_only", "require_secure_transport"]) world.set(`${ids["mysql/db"]}/configurations/${config}`, { properties: { value: "ON" } });
  world.set(`${ids["mysql/db"]}/administrators/ActiveDirectory`, { properties: { sid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } });
  return { world, ids };
}
