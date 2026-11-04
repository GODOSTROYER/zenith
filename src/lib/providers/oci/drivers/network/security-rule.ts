/**
 * `oci:security_list_rule` — portable `firewall` on OCI, realized as a
 * NETWORK SECURITY GROUP RULE, not a security-list rule.
 *
 * Why NSGs (the mapping, in full):
 *   A `firewall/*` node is "allow <source> → <target> on tcp/<port>", where the
 *   target is ONE protected node and the source is another node or a CIDR.
 *   OCI security lists attach to SUBNETS, so a list rule would open the port to
 *   every VNIC in the subnet. An NSG attaches to individual VNICs and a rule's
 *   source can be ANOTHER NSG, which is exactly "from this node". So:
 *
 *     - every node that can be protected (load balancer, container instances,
 *       PostgreSQL, Redis) creates its OWN NSG (`<label>_nsg`) and publishes its
 *       id as the local `<label>_nsg_id`; its VNICs join that NSG;
 *     - this driver adds ONE `oci_core_network_security_group_security_rule`
 *       (INGRESS, TCP, destination port = spec.port, stateful) to the TARGET's
 *       NSG, with source = the source node's NSG (`NETWORK_SECURITY_GROUP`) or a
 *       CIDR (`CIDR_BLOCK`);
 *     - the subnets' security list carries NO ingress (vcn.ts), so NSG rules are
 *       the only way in. OCI evaluates the union of list and NSG rules.
 *
 * Fail-closed rules (compile throws, nothing is emitted):
 *   - a world-open source (prefix shorter than /8, which includes 0.0.0.0/0) is
 *     accepted ONLY for capability `public_http` targeting a load balancer;
 *   - the target and a node source must be managed NSG owners; Zenith never
 *     edits a node it does not own;
 *   - `crossBoundary` rules (cross_cloud / cross_region) cannot be expressed as
 *     an NSG reference and are refused rather than silently widened to a CIDR.
 *
 * Observe: find the target's NSG (and the source's) by Zenith tags in the
 * compartment, read its rules, report whether the rule exists (`allowed`) and
 * whether any ingress rule admits the port from the whole internet
 * (`publicIngress`). Security rules carry no tags, so presence means "the rule
 * exists", proven by a successful rule listing.
 */
import type { CompileContext, NativeOperationResult, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { FirewallSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxRef, NSG_OWNER_TYPES, TAG_ENV, TAG_RESOURCE } from "../../naming";
import {
  arrayOrItems,
  asNumber,
  asRecord,
  asString,
  attributesOf,
  isGone,
  listAll,
  observationOf,
  tagsOf,
  unreadableObservation,
  verifyWith,
  type Located,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, assertCidr, assertPort, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const FIREWALL_NATIVE_TYPE = "oci:security_list_rule";
const ID = ociDriverId(FIREWALL_NATIVE_TYPE);

const OPEN_PREFIX_BELOW = 8;
const cidrPrefix = (cidr: string): number => Number(cidr.slice(cidr.indexOf("/") + 1));
/** Is this source (effectively) the whole internet? */
export const isWorldOpen = (cidr: string): boolean => cidrPrefix(cidr) < OPEN_PREFIX_BELOW;

function owner(ctx: CompileContext, node: ResourceNode, address: string, role: string): ResourceNode {
  const n = ctx.node(address);
  if (!n) throw new OciCompileError(`${node.address}: firewall ${role} "${address}" is not in the graph.`);
  if (n.provider !== "oci") throw new OciUnsupportedError(`${node.address}: firewall ${role} "${address}" is on ${n.provider}; an OCI NSG rule cannot reference it. Cross-cloud access needs an explicit CIDR rule, which Zenith does not derive.`);
  if (n.ownership !== "managed") throw new OciUnsupportedError(`${node.address}: firewall ${role} "${address}" is ${n.ownership}; Zenith never edits a node it does not manage.`);
  if (!NSG_OWNER_TYPES.includes(n.nativeType)) throw new OciUnsupportedError(`${node.address}: firewall ${role} "${address}" (${n.nativeType}) has no network security group; only ${NSG_OWNER_TYPES.join(", ")} can be protected or be a rule source.`);
  return n;
}

export function compileSecurityRule(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<FirewallSpec>(node);
  if (spec.direction !== "ingress" || spec.protocol !== "tcp") throw new OciUnsupportedError(`${node.address}: only ingress tcp rules are derived; got ${String(spec.direction)}/${String(spec.protocol)}.`);
  const port = assertPort(node, spec.port);
  if (spec.crossBoundary) throw new OciUnsupportedError(`${node.address}: a ${spec.crossBoundary} rule cannot be an NSG reference. Allow the source's CIDR explicitly outside Zenith, or keep both nodes in one VCN.`);
  const target = owner(ctx, node, spec.target, "target");
  compartmentOf(ctx); // fail early, with the standard message, when the context is unscoped

  const rule = res("oci_core_network_security_group_security_rule", node);
  const body: Record<string, unknown> = {
    network_security_group_id: auxRef(target.address, "nsg_id"),
    direction: "INGRESS",
    protocol: "6",
    stateless: false,
    description: String(spec.description ?? "").slice(0, 255) || `zenith ${spec.capability}`,
    tcp_options: { destination_port_range: { min: port, max: port } },
  };

  if ("cidr" in spec.source) {
    const cidr = assertCidr(node, spec.source.cidr, "source cidr");
    if (isWorldOpen(cidr) && !(spec.capability === "public_http" && target.nativeType === "oci:load_balancer")) {
      throw new OciCompileError(`${node.address}: source ${cidr} is open to the internet; that is only allowed for capability public_http into a load balancer (this rule is ${spec.capability} into ${target.nativeType}).`);
    }
    body.source = cidr;
    body.source_type = "CIDR_BLOCK";
  } else {
    const source = owner(ctx, node, spec.source.address, "source");
    body.source = auxRef(source.address, "nsg_id");
    body.source_type = "NETWORK_SECURITY_GROUP";
  }

  return { resource: { oci_core_network_security_group_security_rule: { [rule.label]: body } }, addresses: addressList(rule.address, []) };
}

export function securityRuleExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<FirewallSpec>(node);
  return { allowed: true, publicIngress: "cidr" in spec.source && isWorldOpen(spec.source.cidr) };
}

/* --------------------------------- observe --------------------------------- */

interface Rule {
  id?: string;
  direction?: string;
  protocol?: string;
  source?: string;
  sourceType?: string;
  min?: number;
  max?: number;
}

const toRule = (raw: unknown): Rule => {
  const r = asRecord(raw) ?? {};
  const range = asRecord(asRecord(r.tcpOptions)?.destinationPortRange);
  return { id: asString(r.id), direction: asString(r.direction), protocol: asString(r.protocol), source: asString(r.source), sourceType: asString(r.sourceType), min: asNumber(range?.min), max: asNumber(range?.max) };
};

const admitsPort = (r: Rule, port: number): boolean => {
  if (r.direction !== "INGRESS") return false;
  if (r.protocol === "all") return true;
  if (r.protocol !== "6") return false;
  return r.min === undefined || r.max === undefined ? true : r.min <= port && port <= r.max;
};

const OPEN_SOURCES = new Set(["0.0.0.0/0", "::/0"]);

async function nsgsByAddress(ctx: OciContext, node: ResourceNode) {
  const listed = await listAll(ctx, { service: "core", region: node.region || ctx.region, method: "GET", path: ociPath("core", "networkSecurityGroups"), query: { compartmentId: ctx.session.compartmentOcid } }, arrayOrItems);
  if (!listed.ok) return listed;
  const byAddress = new Map<string, string>();
  for (const i of listed.items) {
    if (isGone(i)) continue;
    const t = tagsOf(i);
    const id = asString(asRecord(i)?.id);
    if (id && t[TAG_ENV] === ctx.environmentId && t[TAG_RESOURCE]) byAddress.set(t[TAG_RESOURCE], id);
  }
  return { ok: true as const, byAddress, truncated: listed.truncated, requestIds: listed.requestIds };
}

async function readRules(ctx: OciContext, node: ResourceNode, nsgId: string) {
  const listed = await listAll(ctx, { service: "core", region: node.region || ctx.region, method: "GET", path: ociPath("core", "networkSecurityGroups", nsgId, "securityRules") }, arrayOrItems);
  if (!listed.ok) return listed;
  return { ok: true as const, rules: listed.items.map(toRule), truncated: listed.truncated, requestIds: listed.requestIds };
}

export async function observeSecurityRule(ctx: OciContext, node: ResourceNode, _externalId?: string): Promise<Observation> {
  const spec = specOf<FirewallSpec>(node);
  const nsgs = await nsgsByAddress(ctx, node);
  if (!nsgs.ok) {
    const f = nsgs.failure;
    const presence = f.outcome === "denied" || f.outcome === "not_found" ? "inaccessible" : "unknown";
    return unreadableObservation(ctx, node, ID, f.message, presence);
  }
  const targetId = nsgs.byAddress.get(spec.target);
  const requestIds = [...nsgs.requestIds];
  const miss = (error?: string): Located => ({ presence: error ? "unknown" : "missing", requestIds, ...(error ? { error } : {}) });
  if (!targetId) return observationOf(ctx, node, ID, nsgs.truncated ? miss("The target's NSG was not found in a truncated listing.") : miss());

  const rules = await readRules(ctx, node, targetId);
  if (!rules.ok) {
    const f = rules.failure;
    return unreadableObservation(ctx, node, ID, f.message, f.outcome === "denied" ? "inaccessible" : "unknown");
  }
  requestIds.push(...rules.requestIds);

  let match: Rule | undefined;
  if ("cidr" in spec.source) {
    const cidr = spec.source.cidr;
    match = rules.rules.find((r) => admitsPort(r, spec.port) && r.sourceType === "CIDR_BLOCK" && r.source === cidr);
  } else {
    const sourceId = nsgs.byAddress.get(spec.source.address);
    match = sourceId ? rules.rules.find((r) => admitsPort(r, spec.port) && r.sourceType === "NETWORK_SECURITY_GROUP" && r.source === sourceId) : undefined;
  }
  const publicIngress = rules.rules.some((r) => admitsPort(r, spec.port) && r.sourceType === "CIDR_BLOCK" && r.source !== undefined && (OPEN_SOURCES.has(r.source) || (r.source.includes("/") && !r.source.includes(":") && isWorldOpen(r.source))));
  const at = ctx.now().toISOString();
  const located: Located = match
    ? { presence: "present", item: { id: match.id }, externalId: match.id, requestIds }
    : rules.truncated
      ? { presence: "unknown", requestIds, error: "The rule was not found in a truncated listing." }
      : { presence: "missing", requestIds };
  return observationOf(ctx, node, ID, located, attributesOf(at, { allowed: match !== undefined, publicIngress }), { nsgId: targetId, ruleCount: rules.rules.length });
}

/* ------------------------------- operations -------------------------------- */

/** `firewall.inspect`: the target NSG's rules, bounded. Read-only. */
async function inspect(ctx: OciContext, node: ResourceNode): Promise<NativeOperationResult> {
  const spec = specOf<FirewallSpec>(node);
  const nsgs = await nsgsByAddress(ctx, node);
  if (!nsgs.ok) return { ok: false, summary: nsgs.failure.message, simulated: false, requestIds: nsgs.requestIds };
  const id = nsgs.byAddress.get(spec.target);
  if (!id) return { ok: false, summary: `No network security group tagged for ${spec.target} was found.`, simulated: false, requestIds: nsgs.requestIds };
  const rules = await readRules(ctx, node, id);
  if (!rules.ok) return { ok: false, summary: rules.failure.message, simulated: false, requestIds: [...nsgs.requestIds, ...rules.requestIds] };
  const shown = rules.rules.slice(0, 100).map((r) => ({ direction: r.direction, protocol: r.protocol, source: r.source, sourceType: r.sourceType, portMin: r.min, portMax: r.max }));
  return {
    ok: true,
    summary: `${rules.rules.length} rule${rules.rules.length === 1 ? "" : "s"} on the NSG protecting ${spec.target}.`,
    data: { rules: shown, truncated: rules.rules.length > shown.length || rules.truncated },
    requestIds: [...nsgs.requestIds, ...rules.requestIds],
    simulated: false,
  };
}

export const securityRuleDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "firewall",
  nativeType: FIREWALL_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, operations: ["firewall.inspect"] }),
  compile: compileSecurityRule,
  observe: observeSecurityRule,
  expectedAttributes: securityRuleExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: securityRuleExpected(node), now: ctx.now() }),
  operations: { "firewall.inspect": async (ctx, node) => inspect(ctx, node) },
};
