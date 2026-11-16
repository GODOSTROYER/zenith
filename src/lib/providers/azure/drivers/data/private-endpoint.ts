/**
 * Shared compile pieces for the data services: a private endpoint in the
 * landing zone's endpoint subnet registered in the matching private DNS zone,
 * and the deletion-protection pair (tofu `prevent_destroy` + Azure
 * `CanNotDelete` lock) every stateful Azure resource carries unless the spec's
 * `deletionPolicy` is `allow`.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { block } from "@/lib/providers/azure/compile-util";
import { exportRef } from "@/lib/providers/azure/exports";
import { azureTags, scopedName, tfLabel } from "@/lib/providers/azure/naming";

export interface PrivateEndpointInput {
  node: ResourceNode;
  ctx: CompileContext;
  network: string;
  /** tofu expression of the target resource id */
  targetId: string;
  /** e.g. `redisCache`, `blob` */
  subresource: string;
  zone: "dns_redis_id" | "dns_blob_id" | "dns_queue_id" | "dns_web_id";
}

export function privateEndpoint(i: PrivateEndpointInput): Record<string, Record<string, Record<string, unknown>>> {
  const label = tfLabel(i.node.address, `pe_${i.subresource}`);
  return block("azurerm_private_endpoint", label, {
    name: scopedName(i.node.address, { max: 80, suffix: `pe-${i.subresource}` }),
    location: i.node.region,
    resource_group_name: exportRef(i.network, "rg_name"),
    subnet_id: exportRef(i.network, "snet_pe_id"),
    private_service_connection: { name: i.subresource, private_connection_resource_id: i.targetId, subresource_names: [i.subresource], is_manual_connection: false },
    private_dns_zone_group: { name: "default", private_dns_zone_ids: [exportRef(i.network, i.zone)] },
    tags: azureTags(i.ctx, i.node),
  });
}

/** `CanNotDelete` lock on a stateful resource, unless deletion is allowed. */
export function deletionLock(node: ResourceNode, targetId: string, deletionPolicy: string | undefined): Record<string, Record<string, Record<string, unknown>>> {
  if (deletionPolicy === "allow") return {};
  return block("azurerm_management_lock", tfLabel(node.address, "lock"), {
    name: "zenith-protect",
    scope: targetId,
    lock_level: "CanNotDelete",
    notes: "Zenith: deletionPolicy is not allow",
  });
}

export const protectFromDestroy = (deletionPolicy: string | undefined): boolean => deletionPolicy !== "allow";
