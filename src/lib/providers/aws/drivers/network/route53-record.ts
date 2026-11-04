/**
 * `aws:route53_record` (kind `dns_record`): an alias A record in a referenced
 * public hosted zone, pointing at a load balancer (or static site) Zenith built.
 *
 * Compile: one `aws_route53_record` of type `A` with an `alias` block from
 * `ctx.ref(<target>, "dns_name")` / `"zone_id"` and `evaluate_target_health`
 * on. `allow_overwrite = false` is deliberate: applying a record that already
 * exists fails instead of silently taking over someone else's name. There is no
 * AAAA record because the load balancer is IPv4-only (an AAAA alias to it would
 * resolve to nothing). Refused at compile: a record name outside the zone's
 * name, a zone node that is not a dns_zone, and a target that is not a managed
 * AWS load balancer or static site (targets must publish `dns_name` + `zone_id`).
 *
 * Observe: the zone is found by NAME from the zone node's address
 * (`dns_zone/<apex>`, graph expansion's convention), the record by
 * ListResourceRecordSets. `externalId` is the OpenTofu import id
 * `<zoneId>_<name>_A` (Route 53 record sets have no API id of their own).
 * Route 53 records cannot be tagged, so `native.tags` is `{}` and discovery is
 * not offered (enumerating every record of every zone is neither cheap nor
 * tag-filterable).
 *
 * Attributes: `name`, `type` (`A`), `aliased` (true), `evaluateTargetHealth`, and
 * `target`. `target` is where the alias points, in the form the spec uses: when
 * the alias DNS name is the one of the load balancer Zenith created for
 * `spec.target` (found by Zenith tags, never by name) it is that node's ADDRESS
 * (`load_balancer/public`); any other alias reads as its raw DNS name, so a
 * re-pointed record differs from the desired graph and says where it points now.
 * It is `unknown` when that load balancer could not be looked up (denied,
 * throttled, several matches). For a non-load-balancer target `target` is the raw
 * DNS name and observed-only (no desired value). The attribute is named `aliased`
 * rather than `alias` on purpose: the incident engine treats an attribute called
 * `alias` as the record's target.
 *
 * NO network probes: whether the name RESOLVES on the public internet belongs to
 * the verify-application activity. `verify` here checks the record exists, is an
 * alias with target-health evaluation, and that it points at what the graph says.
 *
 * Dangling-DNS protection: {@link assessRecordDeletion} is a read-only guard the
 * destroy/apply workflow calls before any plan that DELETES this record. It says
 * `safe: false` when the live record points at something Zenith did not create
 * (someone re-pointed the name), so a destroy never removes a record that no
 * longer belongs to Zenith's resource.
 *
 * Permissions read: route53:ListHostedZonesByName, route53:ListResourceRecordSets
 * and, for a load-balancer target, elasticloadbalancing:DescribeLoadBalancers /
 * DescribeTags.
 *
 * Evidence: `contract` only (mocked Route 53 / ELBv2 clients).
 */
import { ListResourceRecordSetsCommand, Route53Client, type ResourceRecordSet } from "@aws-sdk/client-route-53";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { DnsRecordSpec, DnsZoneSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type Attempt,
  type AwsDriverContext,
  DriverCompileError,
  FragmentBuilder,
  REF,
  attempt,
  attributesFromAttempts,
  attributesOf,
  boundNative,
  classifyAwsError,
  failedObservation,
  nowIso,
  refExpr,
  standardVerification,
  tfLabel,
  unknownAttributes,
} from "../shared";
import { findLoadBalancer } from "./alb-lookup";
import { bareZoneId, findPublicZones, normalizeZoneName } from "./route53-zone";

const SOURCE = "aws.route53_record@1";
const ATTRIBUTES = ["name", "type", "aliased", "evaluateTargetHealth", "target"] as const;
const ALIAS_TARGET_KINDS = ["load_balancer", "static_site"];

const normalizeRecordName = (name: unknown): string | undefined => normalizeZoneName(name);
/** `dns_zone/example.com` → `example.com` (graph expansion's address convention). */
export const zoneNameOfAddress = (zoneAddress: string): string | undefined => (zoneAddress.startsWith("dns_zone/") ? normalizeZoneName(zoneAddress.slice("dns_zone/".length)) : undefined);
/** An alias target's DNS name, comparable: lowercase, no trailing dot, no `dualstack.` prefix. */
export const comparableDnsName = (name: string): string => name.toLowerCase().replace(/\.$/, "").replace(/^dualstack\./, "");

export function compileRecord(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not write DNS records for a ${node.ownership} node.`);
  const spec = node.spec as Partial<DnsRecordSpec>;
  const name = normalizeRecordName(spec.name);
  if (!name) throw new DriverCompileError("invalid_spec", node.address, `spec.name must be a DNS name, got ${JSON.stringify(spec.name)}.`);
  if (spec.type !== "alias") throw new DriverCompileError("unsupported", node.address, `record type ${JSON.stringify(spec.type)} is not supported; only alias records are compiled.`);
  if (typeof spec.zone !== "string" || typeof spec.target !== "string") throw new DriverCompileError("invalid_spec", node.address, "spec.zone and spec.target must be node addresses.");

  const zone = ctx.node(spec.zone);
  if (!zone || zone.kind !== "dns_zone") throw new DriverCompileError("missing_node", node.address, `zone ${spec.zone} is not a dns_zone in the graph.`);
  const zoneName = normalizeZoneName((zone.spec as Partial<DnsZoneSpec>).name);
  if (!zoneName || (name !== zoneName && !name.endsWith(`.${zoneName}`))) {
    throw new DriverCompileError("policy_refused", node.address, `${name} is not inside the zone ${zoneName ?? spec.zone}; Zenith only writes records under the zone the manifest named.`);
  }
  const target = ctx.node(spec.target);
  if (!target) throw new DriverCompileError("missing_node", node.address, `alias target ${spec.target} is not in the graph.`);
  if (target.provider !== "aws" || target.ownership !== "managed" || !ALIAS_TARGET_KINDS.includes(target.kind)) {
    throw new DriverCompileError("unsupported", node.address, `alias target ${spec.target} is a ${target.ownership} ${target.provider} ${target.kind}; only managed AWS load balancers and static sites can be aliased.`);
  }

  const L = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  b.resource("aws_route53_record", L, {
    zone_id: refExpr(ctx.ref(spec.zone, REF.zoneId)),
    name,
    type: "A",
    allow_overwrite: false,
    alias: [{ name: refExpr(ctx.ref(spec.target, REF.dnsName)), zone_id: refExpr(ctx.ref(spec.target, REF.zoneId)), evaluate_target_health: true }],
  });
  b.expose("fqdn", `aws_route53_record.${L}.fqdn`);
  return b.build();
}

type LoadBalancerTargetSpec = Partial<DnsRecordSpec> & { target: string };
const isLoadBalancerTarget = (spec: Partial<DnsRecordSpec>): spec is LoadBalancerTargetSpec => typeof spec.target === "string" && spec.target.startsWith("load_balancer/");

export function expectedRecordAttributes(node: ResourceNode): Record<string, unknown> {
  const spec = node.spec as Partial<DnsRecordSpec>;
  const name = normalizeRecordName(spec.name);
  if (!name) return {};
  return { name, type: "A", aliased: true, evaluateTargetHealth: true, ...(isLoadBalancerTarget(spec) ? { target: spec.target } : {}) };
}

interface LiveRecord {
  zoneId: string;
  record?: ResourceRecordSet;
  zones: number;
}

async function findRecord(ctx: AwsDriverContext, r53: Route53Client, node: ResourceNode): Promise<LiveRecord | { invalid: string }> {
  const spec = node.spec as Partial<DnsRecordSpec>;
  const name = normalizeRecordName(spec.name);
  const zoneName = typeof spec.zone === "string" ? zoneNameOfAddress(spec.zone) : undefined;
  if (!name) return { invalid: "spec.name is not a DNS name" };
  if (!zoneName) return { invalid: `cannot derive the zone name from ${JSON.stringify(spec.zone)} (expected dns_zone/<name>)` };
  const zones = await findPublicZones(ctx, r53, zoneName);
  if (zones.length !== 1 || !zones[0].Id) return { zoneId: "", zones: zones.length };
  const zoneId = bareZoneId(zones[0].Id);
  const r = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: name, StartRecordType: "A", MaxItems: 5 }), { abortSignal: ctx.signal });
  const record = (r.ResourceRecordSets ?? []).find((rr) => rr.Type === "A" && !rr.SetIdentifier && normalizeRecordName(rr.Name) === name);
  return { zoneId, record, zones: 1 };
}

/**
 * Where the alias points: `spec.target` when it is the load balancer Zenith created for that node,
 * else the raw alias DNS name. A failed or inconclusive lookup is a failed `Attempt` (→ unknown).
 */
async function resolveAliasTarget(ctx: AwsDriverContext, spec: Partial<DnsRecordSpec>, aliasDns: string): Promise<Attempt<string>> {
  const raw = comparableDnsName(aliasDns);
  if (!isLoadBalancerTarget(spec)) return { ok: true, value: raw };
  return attempt(async () => {
    const found = await findLoadBalancer(ctx, ctx.session.client(ElasticLoadBalancingV2Client), spec.target);
    if (found.matches > 1) throw Object.assign(new Error(`${found.matches} load balancers carry the Zenith tags of ${spec.target}`), { name: "AmbiguousMatch" });
    if (found.matches === 0 && found.truncated) throw Object.assign(new Error("the load balancer search hit its page bound"), { name: "SearchTruncated" });
    return found.lb?.DNSName !== undefined && comparableDnsName(found.lb.DNSName) === raw ? spec.target : raw;
  }, ctx.signal);
}

async function observeRecord(ctx: AwsDriverContext, node: ResourceNode): Promise<Observation> {
  const base = { address: node.address, observedAt: nowIso(ctx), source: SOURCE, simulated: false };
  const r53 = ctx.session.client(Route53Client);
  let live: LiveRecord | { invalid: string };
  try {
    live = await findRecord(ctx, r53, node);
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, ATTRIBUTES, failure);
  }
  if ("invalid" in live) return { ...base, presence: "unknown", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", live.invalid), error: live.invalid };
  if (live.zones > 1) return { ...base, presence: "unknown", attributes: unknownAttributes(ATTRIBUTES, "error", "more than one public hosted zone has the zone's name"), error: "ambiguous hosted zone; refusing to pick one." };
  if (live.zones === 0 || !live.record) {
    return { ...base, presence: "missing", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", live.zones === 0 ? "the hosted zone does not exist" : "no A record has this name"), native: { tags: {}, taggable: false } };
  }
  const rr = live.record;
  const name = normalizeRecordName(rr.Name) as string;
  const target: Attempt<unknown> = rr.AliasTarget?.DNSName ? await resolveAliasTarget(ctx, node.spec as Partial<DnsRecordSpec>, rr.AliasTarget.DNSName) : { ok: true, value: undefined };
  return {
    ...base,
    externalId: `${live.zoneId}_${name}_A`,
    presence: "present",
    attributes: {
      ...attributesOf(ctx, ATTRIBUTES, { name, type: rr.Type, aliased: rr.AliasTarget !== undefined, evaluateTargetHealth: rr.AliasTarget?.EvaluateTargetHealth === true }),
      ...attributesFromAttempts(ctx, ["target"], { target }),
    },
    native: boundNative(
      {
        hostedZoneId: live.zoneId,
        recordName: name,
        recordType: rr.Type,
        aliasTargetDnsName: rr.AliasTarget?.DNSName,
        aliasTargetHostedZoneId: rr.AliasTarget?.HostedZoneId,
        ttl: rr.TTL,
        taggable: false,
        tags: {},
      },
      { priority: ["hostedZoneId", "aliasTargetDnsName", "tags"] }
    ),
  };
}

/**
 * Dangling-DNS guard. `safe: true` when deleting the record cannot remove a name
 * that now belongs to something else: the record is already gone, or it still
 * aliases the load balancer Zenith created for this node's target. Anything
 * else — re-pointed elsewhere, an alias target Zenith did not create, a target
 * that is not a Zenith load balancer, or a state that could not be read — is
 * `safe: false` with the reason: ownership is never assumed.
 */
export async function assessRecordDeletion(ctx: AwsDriverContext, node: ResourceNode, observation?: Observation): Promise<{ safe: boolean; reason: string }> {
  const obs = observation ?? (await observeRecord(ctx, node));
  if (obs.presence === "missing") return { safe: true, reason: "the record does not exist; there is nothing to delete" };
  if (obs.presence !== "present") return { safe: false, reason: `the record could not be read (${obs.presence}); refusing to delete a record whose target is unknown` };
  const spec = node.spec as Partial<DnsRecordSpec>;
  if (!isLoadBalancerTarget(spec)) return { safe: false, reason: "the record does not alias a Zenith load balancer, so its ownership cannot be confirmed" };
  const target = obs.attributes.target;
  if (!target || target.state !== "known") return { safe: false, reason: "where the record points could not be read, so whether Zenith owns the target is unconfirmed" };
  if (target.value === spec.target) return { safe: true, reason: "the record still aliases the load balancer Zenith created" };
  return { safe: false, reason: `the record points at ${String(target.value)}, not at the load balancer Zenith created (${spec.target}); it may no longer belong to Zenith` };
}

export const route53RecordDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "dns_record",
  nativeType: "aws:route53_record",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: false,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract" },
  },
  compile: compileRecord,
  observe: observeRecord,
  expectedAttributes: expectedRecordAttributes,
  async verify(ctx, node, observation) {
    return standardVerification(ctx, node, observation, expectedRecordAttributes(node), "the DNS record");
  },
};
