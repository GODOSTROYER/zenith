/**
 * Deterministic naming, tagging and cross-node reference conventions shared by
 * every OCI driver (DRIVER-CONVENTIONS "Compile").
 *
 * tofu labels     `service/web` → `service_web` (`[a-z0-9_]`). The node's PRIMARY
 *                 resource (`fragment.addresses[0]`) is `<type>.<label>`; extra
 *                 resources add a suffix (`service_web_nsg`).
 *
 * references      `ctx.ref(address, attribute)` reaches an attribute of the
 *                 referenced node's primary resource (`${oci_core_vcn.network_main.id}`).
 *                 Everything else another node needs (an NSG id, a route table
 *                 id, the list of a workload's private IPs, a looked-up
 *                 certificate id) is published by its owner as a tofu LOCAL named
 *                 `<label>_<what>` and read back with `auxRef(address, what)`.
 *                 Locals keep the assembler's duplicate and ownership checks
 *                 intact and avoid depending on how the orchestrator's `ref()`
 *                 resolves data sources or secondary resources.
 *
 * tags            OCI free-form tag keys may not contain periods or spaces and
 *                 each resource carries at most 10. The Zenith keys
 *                 (`zenith:environment`, …) are written as `zenith_environment`
 *                 so a colon can never be the reason an apply is rejected (the
 *                 OCI docs are ambiguous about colons). Observation maps them back.
 *
 * cloud names     `${namePrefix}-<node-name>`; over a provider's limit they are
 *                 truncated with a deterministic 6-hex fnv1a suffix.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { OciCompileError } from "./errors";

/** `${expr}` without template-literal escaping noise. */
export const interp = (expr: string): string => "${" + expr + "}";

export const tfLabel = (address: string): string => {
  const s = address.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
};

/** `kind/name` → `name` */
export const nameOf = (address: string): string => address.slice(address.indexOf("/") + 1);

/** fnv1a 32-bit, first 6 hex digits: a stable disambiguator, not a security hash. */
export function fnv6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** `${prefix}-<name>` bounded to `max` characters with a hash suffix when cut. */
export function cloudName(prefix: string, name: string, max: number): string {
  const base = `${prefix}-${name}`.toLowerCase();
  if (base.length <= max) return base;
  return `${base.slice(0, Math.max(1, max - 7)).replace(/-+$/, "")}-${fnv6(base)}`;
}

/** Display name for a node: `${ctx.namePrefix}-<node-name>`. */
export const nodeCloudName = (ctx: CompileContext, node: ResourceNode, max = 100): string => cloudName(ctx.namePrefix, nameOf(node.address), max);

/* ---------------------------------- tags ---------------------------------- */

export const ociTagKey = (key: string): string => key.replace(/[^A-Za-z0-9_-]/g, "_");

/** `zenith_environment` → `zenith:environment`, so observations speak the platform's tag vocabulary. */
export const zenithTagKey = (ociKey: string): string => (ociKey.startsWith("zenith_") ? `zenith:${ociKey.slice("zenith_".length)}` : ociKey);

export const TAG_ENV = ociTagKey("zenith:environment");
export const TAG_RESOURCE = ociTagKey("zenith:resource");
export const TAG_MANAGED = ociTagKey("zenith:managed");
export const MAX_FREEFORM_TAGS = 10;
const MAX_TAG_VALUE = 256;

/**
 * The free-form tags every taggable OCI resource of `node` carries: `ctx.tags`
 * plus the environment, resource address and managed marker, keys sanitized.
 * `zenith:resource` is forced to THIS node's address because observation finds
 * objects by (environment, resource), never by name.
 */
export function zenithTags(ctx: CompileContext, node: ResourceNode): Record<string, string> {
  const merged: Record<string, string> = { ...ctx.tags, "zenith:environment": ctx.environmentId, "zenith:resource": node.address, "zenith:managed": "true" };
  const out: Record<string, string> = {};
  for (const k of Object.keys(merged).sort()) out[ociTagKey(k)] = String(merged[k]).slice(0, MAX_TAG_VALUE);
  if (Object.keys(out).length > MAX_FREEFORM_TAGS) {
    throw new OciCompileError(`${node.address}: ${Object.keys(out).length} tags exceed OCI's limit of ${MAX_FREEFORM_TAGS} free-form tags per resource; trim the workspace tags.`);
  }
  return out;
}

/* -------------------------- cross-node references -------------------------- */

export const auxName = (address: string, what: string): string => `${tfLabel(address)}_${what}`;
export const auxRef = (address: string, what: string): string => interp(`local.${auxName(address, what)}`);

/* ---------------------- primary resource of a node -------------------------- */

/**
 * The tofu type of each node's primary resource (or data source). The
 * orchestrator's `ctx.ref(address, attr)` can be `${ociPrimaryAddress(node)}.<attr>`;
 * tests assert that every driver's `addresses[0]` equals it.
 */
export const OCI_PRIMARY_TYPE: Readonly<Record<string, string>> = {
  "oci:vcn": "oci_core_vcn",
  "oci:subnet": "oci_core_subnet",
  "oci:security_list_rule": "oci_core_network_security_group_security_rule",
  "oci:load_balancer": "oci_load_balancer_load_balancer",
  "oci:certificate": "data.oci_certificates_management_certificates",
  "oci:dns_zone": "data.oci_dns_zones",
  "oci:dns_rrset": "oci_dns_rrset",
  "oci:container_instance": "oci_container_instances_container_instance",
  "oci:container_repository": "oci_artifacts_container_repository",
  "oci:postgresql_db_system": "oci_psql_db_system",
  "oci:object_storage_bucket": "oci_objectstorage_bucket",
  "oci:queue": "oci_queue_queue",
  "oci:vault_secret": "oci_vault_secret",
  "oci:dynamic_group": "oci_identity_dynamic_group",
  "oci:log_group": "oci_logging_log_group",
  "oci:block_volume": "oci_core_volume",
  "oci:redis_cluster": "oci_redis_redis_cluster",
  "oci:compute_instance": "oci_core_instance",
  "oci:oke_cluster": "oci_containerengine_cluster",
};

export function ociPrimaryAddress(node: Pick<ResourceNode, "address" | "nativeType">): string | undefined {
  const type = OCI_PRIMARY_TYPE[node.nativeType];
  return type ? `${type}.${tfLabel(node.address)}` : undefined;
}

/* ------------------------------- subnet lookup ------------------------------ */

export interface NetworkPlacement {
  /** the `network/…` address the subnets belong to */
  network: string;
  /** subnet addresses of the requested tier, sorted */
  subnets: string[];
}

/**
 * Where a node lives, from the subnets it depends on. OCI subnets are REGIONAL
 * (no availability domain), so every subnet of a tier covers the whole region
 * and a workload attaches to the first one; extra per-zone subnets derived by
 * expansion are created but are redundant on OCI.
 */
export function networkOf(ctx: CompileContext, node: ResourceNode, tier: "public" | "private"): NetworkPlacement {
  const subnets = node.dependsOn
    .map((a) => ctx.node(a))
    .filter((n): n is ResourceNode => n !== undefined && n.kind === "subnet" && (n.spec as { tier?: string }).tier === tier)
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  if (subnets.length === 0) throw new OciCompileError(`${node.address}: no ${tier} subnet in its dependencies, so it cannot be placed in a network.`);
  const network = (subnets[0].spec as { network?: string }).network;
  if (typeof network !== "string") throw new OciCompileError(`${subnets[0].address}: subnet spec has no network.`);
  return { network, subnets: subnets.map((s) => s.address) };
}

/** Nodes that own a Network Security Group the firewall driver may attach rules to. */
export const NSG_OWNER_TYPES: readonly string[] = ["oci:load_balancer", "oci:container_instance", "oci:postgresql_db_system", "oci:redis_cluster", "oci:compute_instance", "oci:oke_cluster"];
