/**
 * Cross-node references for Azure fragments: per-node EXPORTS as tofu locals.
 *
 * Why not `ctx.ref(address, attribute)` (DRIVER-CONVENTIONS): it has no
 * defined semantics for a node that declares several tofu resources, and most
 * Azure nodes do (the network node owns a resource group, a VNet, three
 * subnets, NSGs, private DNS zones, the Container Apps environment…). A
 * dependent node needs e.g. the resource-group NAME and the ACA subnet ID of
 * the same node, which a single "primary resource" reference cannot express.
 *
 * The convention used by every Azure driver instead:
 *
 *   - the declaring node publishes `locals` named `<label>__<key>` whose value
 *     is a tofu expression (`${azurerm_resource_group.network_main_rg.name}`);
 *   - a dependent node references `${local.<label>__<key>}` via `exportRef`.
 *
 * Both sides build the name with `exportName(address, key)`, so the label of
 * another node is never written down anywhere. Keys are a closed vocabulary
 * (`ExportKey`): adding one means adding it to that node's publisher too.
 *
 * Referencing a local keeps tofu's implicit ordering: a resource that uses
 * `${local.x}` depends on whatever `x` references. If the orchestrator later
 * defines `ctx.ref` for multi-resource nodes, only `exportRef` and
 * `exportLocals` need to change.
 */
import { tfLabel } from "@/lib/providers/azure/naming";

export type ExportKey =
  // landing zone (network node)
  | "rg_name"
  | "location"
  | "tenant_id"
  | "object_id"
  | "subscription_id"
  | "vnet_id"
  | "vnet_name"
  | "snet_aca_id"
  | "snet_pg_id"
  | "snet_pe_id"
  | "cidr_aca"
  | "cidr_pg"
  | "cidr_pe"
  | "nsg_aca_name"
  | "nsg_pg_name"
  | "nsg_pe_name"
  | "dns_pg_id"
  | "dns_redis_id"
  | "dns_blob_id"
  | "cae_id"
  | "cae_name"
  | "cae_default_domain"
  | "cae_static_ip"
  | "cae_verification_id"
  | "law_id"
  | "law_workspace_id"
  | "law_name"
  // generic per-resource
  | "id"
  | "name"
  | "fqdn"
  | "principal_id"
  | "client_id"
  | "login_server"
  | "vault_id"
  | "vault_uri"
  | "secret_uri"
  | "namespace_id"
  | "resource_manager_id"
  | "zone_name"
  | "zone_rg"
  | "app_id";

/** The local's name; deterministic from the node address and the key. */
export const exportName = (address: string, key: ExportKey): string => `${tfLabel(address)}__${key}`;

/** `${local.<name>}` — the expression a dependent node writes into its own fields. */
export const exportRef = (address: string, key: ExportKey): string => `\${local.${exportName(address, key)}}`;

/** The `locals` a node publishes; values are tofu expressions. */
export function exportLocals(address: string, values: Partial<Record<ExportKey, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(values).sort() as ExportKey[]) {
    const v = values[key];
    if (v !== undefined) out[exportName(address, key)] = v;
  }
  return out;
}
