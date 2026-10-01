/**
 * Azure managed disks: empty, service-key encrypted, private export only.
 * No attachment is inferred. Volumes default to deletion protection; callers
 * explicitly opt into deletion. Shared disks and imported disk contents are
 * refused. Compile/ARM reads have contract evidence, never live evidence.
 */
import { block, fragment, mergeBlocks, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { defineAzureDriver, props } from "@/lib/providers/azure/kit";
import { deletionLock, protectFromDestroy } from "@/lib/providers/azure/drivers/data/private-endpoint";
import { integerSpec, invalid, readNumber, readString, rejectCredentials, textSpec } from "@/lib/providers/azure/drivers/more-util";
import type { ResourceNode } from "@/lib/resources/types";

export const MANAGED_DISK = { type: "Microsoft.Compute/disks", apiVersion: "2024-03-02" } as const;
const CLASSES = new Set(["Standard_LRS", "StandardSSD_LRS", "Premium_LRS", "StandardSSD_ZRS", "Premium_ZRS"]);

function settings(node: ResourceNode) {
  const storageClass = textSpec(node, "storageClass", "Premium_LRS");
  if (!CLASSES.has(storageClass)) invalid(node, "unsupported managed disk storageClass.");
  const deletionPolicy = textSpec(node, "deletionPolicy", "deny");
  if (!["deny", "approval", "allow"].includes(deletionPolicy)) invalid(node, "invalid deletionPolicy.");
  if (node.spec.accessModes !== undefined && (!Array.isArray(node.spec.accessModes) || node.spec.accessModes.some((m) => m !== "ReadWriteOnce"))) invalid(node, "only ReadWriteOnce managed disks are supported.");
  return { storageClass, deletionPolicy, sizeGb: integerSpec(node, "sizeGb", 32, 4, 32767) };
}

export const managedDiskDriver = defineAzureDriver({
  id: "azure.managed_disk@1", kind: "volume", nativeType: "azure:managed_disk", arm: MANAGED_DISK,
  compile: (node, ctx) => {
    rejectCredentials(node);
    const spec = settings(node);
    const net = resolveNetwork(node, ctx);
    const label = tfLabel(node.address, "disk");
    const id = `\${azurerm_managed_disk.${label}.id}`;
    return fragment({ resource: mergeBlocks(block("azurerm_managed_disk", label, {
      name: cloudName(ctx, node.address, { max: 80, suffix: "disk" }), location: node.region,
      resource_group_name: exportRef(net, "rg_name"), storage_account_type: spec.storageClass,
      create_option: "Empty", disk_size_gb: spec.sizeGb,
      network_access_policy: "DenyAll", public_network_access_enabled: false,
      tags: azureTags(ctx, node), lifecycle: { prevent_destroy: protectFromDestroy(spec.deletionPolicy) },
    }), deletionLock(node, id, spec.deletionPolicy)), locals: exportLocals(node.address, { id, name: `\${azurerm_managed_disk.${label}.name}` }) });
  },
  expected: (node) => ({ sizeGb: settings(node).sizeGb, storageClass: settings(node).storageClass, encryption: "EncryptionAtRestWithPlatformKey", networkAccessPolicy: "DenyAll", publicNetworkAccess: "Disabled" }),
  read: (res) => ({ sizeGb: readNumber(props(res).diskSizeGB), storageClass: readString(res.sku?.name), encryption: readString((props(res).encryption as Record<string, unknown> | undefined)?.type), networkAccessPolicy: readString(props(res).networkAccessPolicy), publicNetworkAccess: readString(props(res).publicNetworkAccess) }),
  native: (res) => ({ provisioningState: props(res).provisioningState, diskState: props(res).diskState }),
});
