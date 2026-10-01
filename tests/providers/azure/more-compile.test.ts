/** Structure, security and rejected inputs for the additional drivers; no cloud calls. */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { compileAll, compileContext, graphOf, mkNode } from "./_helpers";
import { moreGraph, MORE_ADDRESSES, preparedIdentity, sshPublicKey } from "./_more-fixtures";

type Body = Record<string, unknown>;
const driverFor = (n: { nativeType: string }) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)!;
function compile(address: string, patch: Body = {}, mutate?: (nodes: ReturnType<typeof moreGraph>) => void) {
  const nodes = moreGraph();
  const n = nodes.find((n) => n.address === address)!;
  Object.assign(n.spec, patch);
  mutate?.(nodes);
  return driverFor(n).compile!(n, compileContext(nodes));
}
const body = (f: TofuFragment, type: string): Body => Object.values(f.resource?.[type] ?? {})[0];
const params = (f: TofuFragment) => JSON.parse(String(body(f, "azurerm_resource_group_template_deployment").parameters_content)) as { name: { value: string }; properties: { value: Body }; identity: { value: Body }; sku?: { value: Body } };

describe("additional Azure graph compilation", () => {
  it("assembles deterministically with unique addresses and all local references published", () => {
    const nodes = moreGraph();
    const fragments = compileAll(nodes, driverFor);
    const input = { graph: graphOf(nodes), fragments, providerSet: "azure" as const, region: "westeurope", backend: { kind: "local" as const, path: "azure-test.tfstate" }, tags: {}, providerConfig: { azurerm: { subscription_id: "11111111-2222-3333-4444-555555555555", storage_use_azuread: true, resource_provider_registrations: "none" } } };
    const a = assembleWorkspace(input);
    const b = assembleWorkspace({ ...input, fragments: new Map([...fragments].reverse()) });
    expect(a.configDigest).toBe(b.configDigest);
    const addresses = [...fragments.values()].flatMap((f) => f.addresses);
    expect(new Set(addresses).size).toBe(addresses.length);
    const locals = new Set([...fragments.values()].flatMap((f) => Object.keys(f.locals ?? {})));
    for (const f of fragments.values()) {
      for (const [, key] of JSON.stringify(f).matchAll(/\$\{local\.([a-zA-Z0-9_]+)\}/g)) expect(locals.has(key), key).toBe(true);
    }
    expect(JSON.stringify([...fragments])).toBe(JSON.stringify([...compileAll(moreGraph(), driverFor)]));
  });

  it.each(MORE_ADDRESSES)("%s: names, tags and actual fragment ownership", (address) => {
    const f = compile(address);
    const defined: string[] = [];
    for (const [type, resources] of Object.entries(f.resource ?? {})) {
      for (const [name, b] of Object.entries(resources)) {
        defined.push(`${type}.${name}`);
        if (b.tags) expect(b.tags).toMatchObject({ "zenith:resource": address, "zenith:environment": "env_azure_1", "zenith:managed": "true", "zenith:workspace": "ws_1" });
        if (typeof b.name === "string") expect(b.name.length).toBeLessThanOrEqual(80);
        if (type === "azurerm_resource_group_template_deployment") {
          const p = JSON.parse(String(b.parameters_content));
          expect(p.tags.value).toMatchObject({ "zenith:resource": address, "zenith:workspace": "ws_1" });
        }
      }
    }
    expect(f.addresses).toEqual(defined.sort());
  });

  it.each(MORE_ADDRESSES)("%s: rejects inline credentials without echoing their values", (address) => {
    const secret = "DO-NOT-ECHO-THIS-CREDENTIAL";
    try { compile(address, { administratorPassword: secret }); expect.fail("expected refusal"); }
    catch (error) { expect(String(error)).toContain("inline credentials"); expect(String(error)).not.toContain(secret); }
  });

  it.each([["compute_instance/machine", "azurerm_linux_virtual_machine", 64], ["volume/data", "azurerm_managed_disk", 80], ["mysql/db", "azurerm_mysql_flexible_server", 63], ["function/worker", "template", 32], ["static_site/docs", "template", 60], ["kubernetes_cluster/cluster", "template", 63]] as const)("%s respects its service name limit with long addresses", (address, type, limit) => {
    const nodes = moreGraph(); const n = nodes.find((n) => n.address === address)!;
    const long = `${n.kind}/${"long-workload-name-".repeat(20)}`;
    n.address = long; n.labels["zenith:resource"] = long;
    for (const identity of nodes.filter((n) => n.kind === "identity" && n.spec.workload === address)) identity.spec.workload = long;
    const f = driverFor(n).compile!(n, compileContext(nodes));
    const name = type === "template" ? params(f).name.value : body(f, type).name as string;
    expect(name.length).toBeLessThanOrEqual(limit);
    expect(name).toMatch(/^[a-z][a-z0-9-]+[a-z0-9]$/);
    expect(name).toBe(type === "template" ? params(driverFor(n).compile!(n, compileContext(nodes))).name.value : body(driverFor(n).compile!(n, compileContext(nodes)), type).name);
  });

  it.each(["function/worker", "static_site/docs", "compute_instance/machine"])("%s: refuses missing or ambiguous workload identities", (address) => {
    expect(() => compile(address, {}, (nodes) => { const n = nodes.find((n) => n.address === address)!; n.dependsOn = n.dependsOn.filter((a) => !a.startsWith("identity/")); })).toThrow(/identity/);
    expect(() => compile(address, {}, (nodes) => { const identity = nodes.find((n) => n.kind === "identity" && n.spec.workload === address)!; const copy = structuredClone(identity); copy.address += "-duplicate"; nodes.push(copy); nodes.find((n) => n.address === address)!.dependsOn.push(copy.address); })).toThrow(/identity/);
  });
});

describe("VMs and disks", () => {
  it("VMs have no public IP, an encrypted OS disk, UAI, SSH-off cloud-init and a NIC deny rule", () => {
    const f = compile("compute_instance/machine");
    expect(f.resource).not.toHaveProperty("azurerm_public_ip");
    const vm = body(f, "azurerm_linux_virtual_machine");
    expect(vm).toMatchObject({ disable_password_authentication: true, provision_vm_agent: true, os_disk: { storage_account_type: "Premium_LRS" }, identity: { type: "UserAssigned" } });
    expect(vm).not.toHaveProperty("admin_password");
    expect(Buffer.from(String(vm.custom_data), "base64").toString()).toContain("mask, --now, ssh.service");
    expect(body(f, "azurerm_network_security_group").security_rule).toEqual(expect.arrayContaining([expect.objectContaining({ access: "Deny", priority: 100, destination_port_range: "22" })]));
    expect(JSON.stringify(body(f, "azurerm_network_interface"))).not.toContain("public_ip");
    expect(vm.admin_ssh_key).toEqual([{ username: "zenith", public_key: sshPublicKey }]);
  });

  it.each([{ adminSshPublicKey: "-----BEGIN PRIVATE KEY-----" }, { adminSshPublicKey: "ssh-rsa Zm9v" }, { subnet: "subnet/public-a" }, { osDiskSizeGb: -1 }, { customData: "shell script" }, { instanceClass: "${file(\"secret\")}" }])("refuses invalid VM configuration %j", (patch) => {
    expect(() => compile("compute_instance/machine", patch)).toThrow();
  });

  it("volumes are empty, encrypted, private and protected until deletion is explicitly allowed", () => {
    const protectedDisk = compile("volume/data");
    expect(body(protectedDisk, "azurerm_managed_disk")).toMatchObject({ create_option: "Empty", disk_size_gb: 64, network_access_policy: "DenyAll", public_network_access_enabled: false, lifecycle: { prevent_destroy: true } });
    expect(body(protectedDisk, "azurerm_management_lock").lock_level).toBe("CanNotDelete");
    const allowed = compile("volume/data", { deletionPolicy: "allow" });
    expect(body(allowed, "azurerm_managed_disk").lifecycle).toEqual({ prevent_destroy: false });
    expect(allowed.resource).not.toHaveProperty("azurerm_management_lock");
  });

  it.each([{ sizeGb: 0 }, { sizeGb: 4.5 }, { storageClass: "UltraSSD_LRS" }, { accessModes: ["ReadWriteMany"] }, { deletionPolicy: "sometimes" }])("refuses unsupported volume configuration %j", (patch) => {
    expect(() => compile("volume/data", patch)).toThrow();
  });
});

describe("Functions and template safety", () => {
  it("host storage is private and keyless, roles are scoped to that account, and Key Vault/ACR use the UAI", () => {
    const f = compile("function/worker");
    expect(body(f, "azurerm_storage_account")).toMatchObject({ public_network_access_enabled: false, shared_access_key_enabled: false, min_tls_version: "TLS1_2" });
    const roles = Object.values(f.resource!.azurerm_role_assignment);
    expect(roles.map((r) => r.role_definition_name).sort()).toEqual(["Storage Blob Data Owner", "Storage Queue Data Contributor"]);
    for (const role of roles) expect(role.scope).toMatch(/^\$\{azurerm_storage_account\./);
    const p = params(f).properties.value;
    expect(p).toMatchObject({ httpsOnly: true, publicNetworkAccess: "Disabled" });
    expect(p.keyVaultReferenceIdentity).toMatch(/^\$\{local\./);
    const config = p.siteConfig as Body;
    expect(config).toMatchObject({ acrUseManagedIdentityCreds: true, alwaysOn: true, ftpsState: "Disabled" });
    const env = config.appSettings as { name: string; value: string }[];
    expect(env.find((s) => s.name === "SESSION_KEY")!.value).toMatch(/^@Microsoft.KeyVault\(SecretUri=\$\{local\./);
    expect(env.find((s) => s.name === "AzureWebJobsStorage__credential")!.value).toBe("managedidentity");
    expect(Object.keys(f.resource!.azurerm_private_endpoint)).toHaveLength(3);
    const t = JSON.parse(String(body(f, "azurerm_resource_group_template_deployment").template_content));
    expect(t.resources[0].resources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ftp", properties: { allow: false } }), expect.objectContaining({ name: "scm", properties: { allow: false } })]));
  });

  it("user template delimiters and ARM-looking values remain data", () => {
    const f = compile("function/worker", { env: [{ key: "TEXT", value: "${file(\"private\")} %{if true} [listKeys('x','y')]" }] });
    const env = (params(f).properties.value.siteConfig as Body).appSettings as { name: string; value: string }[];
    expect(env.find((s) => s.name === "TEXT")!.value).toBe('$${file("private")} %%{if true} [listKeys(\'x\',\'y\')]');
    const template = String(body(f, "azurerm_resource_group_template_deployment").template_content);
    expect(template).not.toContain("listKeys");
    expect(template).toContain("[parameters('properties')]");
    const nodes = moreGraph();
    nodes.find((n) => n.address === "function/worker")!.spec.env = [{ key: "TEXT", value: '${file("private")} %{if true} [listKeys(\'x\',\'y\')]' }];
    expect(() => assembleWorkspace({ graph: graphOf(nodes), fragments: compileAll(nodes, driverFor), providerSet: "azure", region: "westeurope", backend: { kind: "local", path: "data-only.tfstate" }, tags: {}, providerConfig: { azurerm: { subscription_id: "11111111-2222-3333-4444-555555555555" } } })).not.toThrow();
  });

  it.each([{ env: [{ key: "PASSWORD", value: "untrusted-value" }] }, { env: [{ key: "AzureWebJobsStorage", value: "bad" }] }, { env: [{ key: "SESSION_KEY", secretRef: "vault:missing" }] }, { artifact: { type: "blueprint", blueprint: "fake" } }, { artifact: { type: "image", ref: "private.example/image:1" } }, { subnet: "subnet/private-a" }, { instanceClass: "FC1" }])("refuses unsafe or unsupported Function configuration %j", (patch) => {
    expect(() => compile("function/worker", patch)).toThrow();
  });

  it.each(["function/worker", "static_site/docs", "kubernetes_cluster/cluster"])("%s: template outputs only ID and hostname; no credential-list expressions", (address) => {
    const f = compile(address);
    const deployment = body(f, "azurerm_resource_group_template_deployment");
    const t = JSON.parse(String(deployment.template_content));
    expect(Object.keys(t.outputs).sort()).toEqual(["hostname", "resourceId"]);
    expect(JSON.stringify(t)).not.toMatch(/listKeys|listSecrets|listCredentials|publishingPassword|kube.?config/i);
    expect(deployment.deployment_mode).toBe("Incremental");
    expect(f.output).toBeUndefined();
  });
});

describe("Static Web Apps", () => {
  it("uses Standard SWA with UAI and a private endpoint, or an explicit public site", () => {
    const f = compile("static_site/docs");
    expect(params(f)).toMatchObject({ properties: { value: { publicNetworkAccess: "Disabled" } }, sku: { value: { name: "Standard" } }, identity: { value: { type: "UserAssigned" } } });
    expect(body(f, "azurerm_private_endpoint")).toMatchObject({ private_service_connection: { subresource_names: ["staticSites"] } });
    const publicSite = compile("static_site/docs", { publicAccess: true });
    expect(params(publicSite).properties.value.publicNetworkAccess).toBe("Enabled");
    expect(publicSite.resource).not.toHaveProperty("azurerm_private_endpoint");
  });
  it("private sites need a prepared DNS zone, and custom subdomains bind after the CNAME exists", () => {
    expect(() => compile("static_site/docs", { privateDnsZoneId: undefined })).toThrow(/privateDnsZoneId/);
    const f = compile("dns_record/docs.example.com");
    expect(f.resource).not.toHaveProperty("azurerm_dns_txt_record");
    expect(body(f, "azurerm_dns_cname_record").name).toBe("docs");
    expect(body(f, "azurerm_static_web_app_custom_domain")).toMatchObject({ validation_type: "cname-delegation", depends_on: ["azurerm_dns_cname_record.dns_record_docs__example__com_cname"] });
    expect(() => compile("dns_record/docs.example.com", { name: "example.com" })).toThrow(/apex/);
  });
});

describe("AKS and MySQL mapping", () => {
  it("AKS has a private API, no local accounts, OIDC/workload identity, Azure CNI and spec-sized pools", () => {
    const f = compile("kubernetes_cluster/cluster");
    const p = params(f).properties.value;
    expect(p).toMatchObject({ apiServerAccessProfile: { enablePrivateCluster: true, enablePrivateClusterPublicFQDN: false, disableRunCommand: true }, disableLocalAccounts: true, enableRBAC: true, oidcIssuerProfile: { enabled: true }, securityProfile: { workloadIdentity: { enabled: true } }, networkProfile: { networkPlugin: "azure", networkPluginMode: "overlay" } });
    expect(p.agentPoolProfiles).toEqual([expect.objectContaining({ name: "system", count: 2, vmSize: "Standard_D2s_v5", mode: "System" })]);
    expect(body(f, "azurerm_kubernetes_cluster_node_pool")).toMatchObject({ name: "workers", node_count: 3, vm_size: "Standard_D4s_v5" });
    expect(params(f).identity.value).toMatchObject({ type: "UserAssigned", userAssignedIdentities: { [preparedIdentity]: {} } });
    expect(f.resource).not.toHaveProperty("azurerm_role_assignment");
  });

  it.each([{ privateCluster: false }, { controlPlaneIdentityId: "/not/an/identity" }, { serviceCidr: "10.0.0.0/16" }, { podCidr: "172.20.0.0/16" }, { serviceCidr: "0.0.0.0/0" }, { nodePools: [{ name: "bad-name", vmSize: "Standard_D2s_v5", count: 2 }] }, { nodeCount: 0, nodePools: undefined }, { nodePools: [{ name: "system", vmSize: "Standard_D2s_v5", count: 1.5 }] }])("refuses invalid AKS configuration %j", (patch) => {
    expect(() => compile("kubernetes_cluster/cluster", patch)).toThrow();
  });

  it("MySQL restores without a password, maps HA/backup/protection, and enforces Entra-only/TLS", () => {
    const f = compile("mysql/db");
    const server = body(f, "azurerm_mysql_flexible_server");
    expect(server).toMatchObject({ create_mode: "PointInTimeRestore", public_network_access: "Disabled", version: "8.0.21", high_availability: { mode: "ZoneRedundant" }, backup_retention_days: 14, lifecycle: { prevent_destroy: true } });
    expect(JSON.stringify(f)).not.toMatch(/administrator_password|random_password/);
    expect(Object.values(f.resource!.azurerm_mysql_flexible_server_configuration).map((b) => ({ name: b.name, value: b.value }))).toEqual([{ name: "aad_auth_only", value: "ON" }, { name: "require_secure_transport", value: "ON" }]);
    expect(body(compile("mysql/db", { backup: "none" }), "azurerm_mysql_flexible_server").backup_retention_days).toBe(7);
    expect(body(compile("mysql/db", { backup: "hourly" }), "azurerm_mysql_flexible_server")).toMatchObject({ backup_retention_days: 35, geo_redundant_backup_enabled: true });
  });

  it("fresh MySQL creation uses an ephemeral admin password on write-only arguments; replicas never claim HA", () => {
    // the shared fixture is a point-in-time restore; a fresh server carries no restore source
    const fresh = compile("mysql/db", { createMode: "Default", restoreTime: undefined, sourceServerId: undefined });
    const server = body(fresh, "azurerm_mysql_flexible_server");
    expect(server.administrator_password).toBeUndefined();
    expect(String(server.administrator_password_wo)).toMatch(/^\$\{ephemeral\./);
    expect(fresh.ephemeral).toBeDefined();
    expect(JSON.stringify(fresh.resource)).not.toMatch(/"administrator_password"\s*:/);
    expect(() => compile("mysql/db", { createMode: "Replica" })).toThrow(/replicas do not support HA/);
    expect(body(compile("mysql/db", { createMode: "Replica", highAvailability: false, deletionPolicy: "allow" }), "azurerm_mysql_flexible_server").create_mode).toBe("Replica");
  });

  it.each([{ highAvailability: true, size: "small" }, { version: "5.7" }, { restoreTime: "not-a-date" }, { subnet: "subnet/private-a" }, { backup: "weekly" }, { entraAdministratorId: "not-a-guid" }])("refuses invalid MySQL configuration %j", (patch) => {
    expect(() => compile("mysql/db", patch)).toThrow();
  });

  it("MySQL uses its own delegated subnet, and its firewall never targets the PostgreSQL NSG", () => {
    const subnet = compile("subnet/mysql");
    expect(body(subnet, "azurerm_subnet").delegation).toEqual([{ name: "mysql", service_delegation: { name: "Microsoft.DBforMySQL/flexibleServers", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] } }]);
    const rule = body(compile("firewall/function-to-mysql"), "azurerm_network_security_rule");
    expect(rule.network_security_group_name).toBe("${local.subnet_mysql__nsg_name}");
    expect(rule.source_address_prefix).toBe("${local.subnet_functions__cidr}");
    expect(() => compile("subnet/mysql", { cidr: "10.0.255.0/26" })).toThrow(/overlaps/);
    expect(() => compile("subnet/functions", { cidr: "10.1.0.0/24" })).toThrow(/within/);
  });

  it("retains Container Apps ingress and refuses gateway-only requirements", () => {
    expect(compile("load_balancer/public").addresses).toEqual([]);
    expect(() => compile("load_balancer/public", { waf: true })).toThrow(/Application Gateway/);
    const route = { host: "app.example.com", target: "container_service/web", tls: true, pathPrefix: "/api" };
    expect(() => compile("load_balancer/public", { routes: [route] })).toThrow(/path-based/);
    const isolated = [mkNode("volume/data", "volume", "azure:managed_disk", { sizeGb: 32 })];
    expect(() => driverFor(isolated[0]).compile!(isolated[0], compileContext(isolated))).toThrow(/network/);
  });
});
