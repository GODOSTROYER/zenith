/**
 * Private Ubuntu VM with managed identity and encrypted disks. AzureRM requires
 * an administrator public SSH key even for Run Command access: the caller
 * supplies that PUBLIC key; cloud-init masks SSH and a NIC NSG blocks port 22.
 * No public IP, password, arbitrary user-data, or guest shell operation is
 * emitted. Run Command remains an operator-side Azure access mechanism, not a
 * declared Zenith operation. Instance view proves power/agent state only;
 * ARM cannot attest that cloud-init stopped SSH, so verification says unknown.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { block, fragment, mergeBlocks, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { defineAzureDriver, pick, props, type RuntimeRead } from "@/lib/providers/azure/kit";
import { privateSubnet, workloadIdentity, integerSpec, invalid, textSpec, rejectCredentials, readString, readBool } from "@/lib/providers/azure/drivers/more-util";
import type { ArmResource, Json } from "@/lib/providers/azure/arm";

export const VIRTUAL_MACHINE = { type: "Microsoft.Compute/virtualMachines", apiVersion: "2024-07-01" } as const;
const SIZE: Record<string, string> = { nano: "Standard_B1s", small: "Standard_B2s", standard: "Standard_D2s_v5", performance: "Standard_D4s_v5" };
const SSH_OFF = Buffer.from("#cloud-config\nruncmd:\n  - [systemctl, mask, --now, ssh.service, ssh.socket, sshd.service]\n").toString("base64");

function vmSize(node: ResourceNode): string {
  const size = textSpec(node, "instanceClass", SIZE[String(node.spec.size ?? "small")]);
  if (!/^Standard_[A-Za-z0-9_]+$/.test(size)) invalid(node, "instanceClass must be an Azure Standard VM SKU.");
  return size;
}

function publicKey(node: ResourceNode): string {
  const key = textSpec(node, "adminSshPublicKey");
  const m = /^ssh-rsa ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]+)?$/.exec(key);
  if (!m) invalid(node, "adminSshPublicKey must be a public RSA SSH key (no private key).");
  const bytes = Buffer.from(m[1], "base64");
  let offset = 0;
  const field = (): Buffer => {
    if (offset + 4 > bytes.length) invalid(node, "invalid public RSA SSH key.");
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (length > bytes.length - offset) invalid(node, "invalid public RSA SSH key.");
    const part = bytes.subarray(offset, offset + length); offset += length;
    return part;
  };
  if (field().toString() !== "ssh-rsa") invalid(node, "invalid public RSA SSH key.");
  field();
  const modulus = field();
  if (modulus.length < 256 || offset !== bytes.length) invalid(node, "a public RSA SSH key of at least 2048 bits is required.");
  return `ssh-rsa ${m[1]}`;
}

export function readVm(res: ArmResource): Record<string, unknown> {
  return { instanceClass: readString(pick(props(res), "hardwareProfile", "vmSize")), passwordAuthDisabled: readBool(pick(props(res), "osProfile", "linuxConfiguration", "disablePasswordAuthentication")), identityType: readString(res.identity?.type), osDiskType: readString(pick(props(res), "storageProfile", "osDisk", "managedDisk", "storageAccountType")) };
}

export const virtualMachineDriver = defineAzureDriver({
  id: "azure.virtual_machine@1", kind: "compute_instance", nativeType: "azure:virtual_machine", arm: VIRTUAL_MACHINE,
  compile: (node, ctx) => {
    rejectCredentials(node);
    if (node.spec.image !== undefined || node.spec.customData !== undefined || node.spec.userData !== undefined) invalid(node, "this VM driver supports the fixed Ubuntu image and SSH-disabled cloud-init only.");
    const subnet = privateSubnet(node, ctx);
    const identity = workloadIdentity(node, ctx);
    const net = resolveNetwork(subnet, ctx);
    const L = (part: string) => tfLabel(node.address, part);
    const tags = azureTags(ctx, node);
    const common = { location: node.region, resource_group_name: exportRef(net, "rg_name"), tags };
    const vm = `azurerm_linux_virtual_machine.${L("vm")}`;
    const nic = `azurerm_network_interface.${L("nic")}`;
    const nsg = `azurerm_network_security_group.${L("nsg")}`;
    return fragment({ resource: mergeBlocks(
      block("azurerm_network_interface", L("nic"), { ...common, name: cloudName(ctx, node.address, { max: 80, suffix: "nic" }), ip_configuration: [{ name: "private", subnet_id: exportRef(subnet.address, "id"), private_ip_address_allocation: "Dynamic" }] }),
      block("azurerm_network_security_group", L("nsg"), { ...common, name: cloudName(ctx, node.address, { max: 80, suffix: "nsg" }), security_rule: [{ name: "deny-ssh", priority: 100, direction: "Inbound", access: "Deny", protocol: "*", source_port_range: "*", destination_port_range: "22", source_address_prefix: "*", destination_address_prefix: "*" }, { name: "deny-inbound", priority: 4096, direction: "Inbound", access: "Deny", protocol: "*", source_port_range: "*", destination_port_range: "*", source_address_prefix: "*", destination_address_prefix: "*" }] }),
      block("azurerm_network_interface_security_group_association", L("nsg_assoc"), { network_interface_id: `\${${nic}.id}`, network_security_group_id: `\${${nsg}.id}` }),
      block("azurerm_linux_virtual_machine", L("vm"), {
        ...common, name: cloudName(ctx, node.address, { max: 64, suffix: "vm" }), size: vmSize(node), admin_username: "zenith",
        admin_ssh_key: [{ username: "zenith", public_key: publicKey(node) }], disable_password_authentication: true,
        network_interface_ids: [`\${${nic}.id}`], identity: { type: "UserAssigned", identity_ids: [identity.id] },
        provision_vm_agent: true, allow_extension_operations: true, custom_data: SSH_OFF,
        os_disk: { caching: "ReadWrite", storage_account_type: "Premium_LRS", disk_size_gb: integerSpec(node, "osDiskSizeGb", 32, 32, 4095) },
        source_image_reference: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" },
        depends_on: [`azurerm_network_interface_security_group_association.${L("nsg_assoc")}`],
      })
    ), locals: exportLocals(node.address, { id: `\${${vm}.id}`, name: `\${${vm}.name}`, nsg_name: `\${${nsg}.name}` }) });
  },
  expected: (node) => ({ instanceClass: vmSize(node), passwordAuthDisabled: true, identityType: "UserAssigned", osDiskType: "Premium_LRS" }),
  read: readVm,
  runtime: async (_ctx, _node, res, arm): Promise<RuntimeRead> => {
    const view = (await arm.get<Json>(`${res.id}/instanceView`, { apiVersion: VIRTUAL_MACHINE.apiVersion })).body;
    const statuses = Array.isArray(view.statuses) ? view.statuses as Json[] : [];
    const power = statuses.map((s) => readString(s.code)).find((s) => s?.startsWith("PowerState/"));
    return { health: power === "PowerState/running" ? "healthy" : power === "PowerState/stopped" || power === "PowerState/deallocated" ? "unhealthy" : "unknown", counts: {}, signals: power ? [power, "guest_application_health_not_inspected"] : ["power_state_not_inspected"] };
  },
  checks: async (_ctx, _node, res, arm) => {
    const nicIds = pick<Json[]>(props(res), "networkProfile", "networkInterfaces");
    if (!Array.isArray(nicIds) || nicIds.length === 0) return [{ id: "private_network", description: "all NICs have no public IP and deny SSH", passed: "unknown" }];
    let complete = true;
    let secure = true;
    for (const ref of nicIds.slice(0, 10)) {
      if (typeof ref.id !== "string") { complete = false; continue; }
      const nic = (await arm.get<ArmResource>(ref.id, { apiVersion: "2024-05-01" })).body;
      const configs = pick<Json[]>(props(nic), "ipConfigurations");
      if (!Array.isArray(configs) || configs.length === 0) complete = false;
      else {
        if (configs.some((c) => typeof pick(c, "properties", "privateIPAddress") !== "string")) complete = false;
        if (configs.some((c) => pick(c, "properties", "publicIPAddress", "id") !== undefined)) secure = false;
      }
      const nsgId = pick<string>(props(nic), "networkSecurityGroup", "id");
      if (!nsgId) { complete = false; continue; }
      const nsg = (await arm.get<ArmResource>(nsgId, { apiVersion: "2024-05-01" })).body;
      const rules = pick<Json[]>(props(nsg), "securityRules");
      if (!Array.isArray(rules)) { complete = false; continue; }
      const deny = rules.find((r) => r.name === "deny-ssh");
      const p = deny ? pick<Json>(deny, "properties") : undefined;
      if (!(p?.direction === "Inbound" && p.access === "Deny" && p.priority === 100 && p.protocol === "*" && p.sourceAddressPrefix === "*" && p.destinationAddressPrefix === "*" && p.sourcePortRange === "*" && p.destinationPortRange === "22")) secure = false;
      if (rules.some((r) => { const p = pick<Json>(r, "properties"); return p?.direction === "Inbound" && typeof p.priority === "number" && p.priority < 100; })) secure = false;
    }
    return [{ id: "private_network", description: "all NICs have no public IP and deny SSH", passed: !secure ? false : complete && nicIds.length <= 10 ? true : "unknown" }, { id: "guest_ssh", description: "SSH daemon is disabled by cloud-init", passed: "unknown", detail: "ARM cannot attest guest configuration; an operator must check using Run Command" }];
  },
  native: (res) => ({ provisioningState: props(res).provisioningState }),
  serving: true,
});
