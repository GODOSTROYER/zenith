/**
 * `aws:security_group_rule` (kind `firewall`): one rule between two nodes'
 * security groups. Compile is in firewall-compile.ts (and the group-ownership
 * decision in shared/security-group.ts); this file is the read side.
 *
 * ONE firewall node = ONE ingress rule. What `observe` reports for it
 *   - presence       `present` when that EXACT rule (tcp, this port, this source)
 *                    exists on the TARGET's group, `missing` when the group exists
 *                    (or does not) WITHOUT it — a rule on the same port from another
 *                    source does not count. The rule is this node's resource, so a
 *                    deleted rule is a missing node, which the incident engine's
 *                    security-group-break scenario relies on;
 *   - `port`, `protocol`, `source`   the rule that was found (known only when it was
 *                    found). `source` is the Zenith node address that owns the
 *                    referenced security group (mapped back through that group's
 *                    `zenith:resource` tag; a group Zenith does not own stays its
 *                    `sg-…` id) or the CIDR, exactly the forms the spec uses, so
 *                    drift compares like with like and a world-open source on a
 *                    rule that should reference a group reads as opened;
 *   - `egressRule`   the companion egress rule's key on the SOURCE's group
 *                    (`egress tcp/5432 sg:postgres/db`) or `null` when it is absent;
 *                    node sources only — the attribute does not exist for a CIDR source;
 *   - externalId     the target's `sg-…` id (even when the rule is missing);
 *   - native         group ids, rule ids, the target's ingress rule keys, any
 *                    world-open ingress, and the group's tags (bounded, ≤ 4 KiB).
 * A denied or throttled read is `inaccessible` / `unknown`, never "no rule".
 *
 * `verify` states exactly which expected rule is missing, and fails when a
 * non-load-balancer target has ingress open to the whole internet that this
 * node does not account for (an unexpected public rule on a database is drift).
 *
 * `firewall.inspect` (read-only, idempotent): the normalized rule list of the
 * target's group (or the source's with `{ group: "source" }`), with this node's
 * expected rules marked present/missing and the observed rules nobody expects.
 * Mutations (`firewall.modify`) are a tofu re-apply, never a native call here.
 *
 * Evidence: `contract` only (mocked EC2 client); nothing has run against AWS.
 */
import { DescribeSecurityGroupsCommand, EC2Client, type SecurityGroup } from "@aws-sdk/client-ec2";
import type { AwsSession } from "@/lib/credentials/types";
import type { DiscoveredResource, NativeOperation, ResourceDriver, VerificationCheck } from "@/lib/drivers/types";
import type { FirewallSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  attributesOf,
  boundNative,
  classifyAwsError,
  failedObservation,
  fromAwsTagList,
  hasZenithManagedTag,
  nowIso,
  paginate,
  unknownAttributes,
  verificationResult,
} from "../shared";
import { compileFirewall } from "./firewall-compile";
import { type NormalizedRule, diffRuleSets, expectedEgress, expectedIngress, isWorldPeer, normalizeRule, ruleKey } from "./firewall-rules";
import { findSecurityGroups, loadRules, resolvePeerAddresses } from "./sg-lookup";

const SOURCE = "aws.security_group_rule@1";
const NATIVE_PRIORITY = ["securityGroupId", "ingressRuleId", "tags"] as const;
const MAX_LISTED_RULES = 100;

type PartialFirewall = Partial<FirewallSpec>;

function specOf(node: ResourceNode): (FirewallSpec & { valid: true }) | { valid: false } {
  const s = node.spec as PartialFirewall;
  const source = s.source;
  const okSource = typeof source === "object" && source !== null && (("address" in source && typeof source.address === "string") || ("cidr" in source && typeof source.cidr === "string"));
  if (typeof s.target !== "string" || typeof s.port !== "number" || !okSource) return { valid: false };
  return { ...(s as FirewallSpec), valid: true };
}

/** The attribute names `observe` reads for this node (egress only exists for node sources). */
export function firewallAttributeNames(node: ResourceNode): string[] {
  const s = specOf(node);
  const base = ["port", "protocol", "source"];
  return s.valid && expectedEgress(s) ? [...base, "egressRule"] : base;
}

/** The source in the form the spec and `observe` share: a node address or a CIDR. */
const sourceOf = (s: Pick<FirewallSpec, "source">): string => ("address" in s.source ? s.source.address : s.source.cidr);

export function expectedFirewallAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf(node);
  if (!s.valid) return {};
  const egress = expectedEgress(s);
  return { port: s.port, protocol: "tcp", source: sourceOf(s), ...(egress ? { egressRule: ruleKey(egress) } : {}) };
}

/** `sg:load_balancer/public` → `load_balancer/public`, `cidr:0.0.0.0/0` → `0.0.0.0/0`, other peers keep their prefix. */
const peerSource = (peer: string): string => (peer.startsWith("sg:") ? peer.slice(3) : peer.startsWith("cidr:") ? peer.slice(5) : peer);

const isSourceAddress = (s: FirewallSpec): s is FirewallSpec & { source: { address: string } } => "address" in s.source;

async function observeFirewall(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const names = firewallAttributeNames(node);
  const spec = specOf(node);
  const base = { address: node.address, observedAt: nowIso(ctx), source: SOURCE, simulated: false };
  if (!spec.valid) {
    return { ...base, presence: "unknown", attributes: unknownAttributes(names, "not_applicable", "the firewall spec has no usable target, port or source"), error: "invalid firewall spec" };
  }
  const ec2 = ctx.session.client(EC2Client);

  let targetGroups: SecurityGroup[];
  let sourceGroups: SecurityGroup[] = [];
  try {
    targetGroups = await findSecurityGroups(ctx, ec2, spec.target, externalId);
    if (isSourceAddress(spec)) sourceGroups = await findSecurityGroups(ctx, ec2, spec.source.address);
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, names, failure, externalId);
  }
  if (targetGroups.length === 0) {
    return { ...base, presence: "missing", attributes: unknownAttributes(names, "not_applicable", "the target's security group does not exist") };
  }
  if (targetGroups.length > 1 || sourceGroups.length > 1) {
    return {
      ...base,
      presence: "unknown",
      attributes: unknownAttributes(names, "error", "more than one security group carries the Zenith tags of a rule endpoint"),
      error: "ambiguous security group tags; refusing to pick one.",
    };
  }
  const targetGroup = targetGroups[0];
  const sourceGroup = sourceGroups[0];
  const targetId = targetGroup.GroupId as string;

  let loaded;
  try {
    loaded = await loadRules(ctx, ec2, sourceGroup?.GroupId ? [targetId, sourceGroup.GroupId] : [targetId]);
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, names, failure, targetId);
  }
  const known = new Map<string, string>([[targetId, spec.target]]);
  if (sourceGroup?.GroupId && isSourceAddress(spec)) known.set(sourceGroup.GroupId, spec.source.address);
  const peers = await resolvePeerAddresses(ctx, ec2, loaded.rules, known);

  const targetIngress = loaded.rules.filter((r) => r.GroupId === targetId && !r.IsEgress);
  const normalizedIngress = targetIngress.map((r) => ({ rule: r, normalized: normalizeRule(r, peers) }));
  const wantIngress = ruleKey(expectedIngress(spec));
  const ingressHit = normalizedIngress.find((x) => ruleKey(x.normalized) === wantIngress);

  const values: Record<string, unknown> = ingressHit ? { port: ingressHit.normalized.fromPort, protocol: ingressHit.normalized.protocol, source: peerSource(ingressHit.normalized.peer) } : {};
  let egressRuleId: string | undefined;
  const egress = expectedEgress(spec);
  if (egress) {
    const wantEgress = ruleKey(egress);
    const hit = loaded.rules.filter((r) => r.IsEgress && r.GroupId === sourceGroup?.GroupId).find((r) => ruleKey(normalizeRule(r, peers)) === wantEgress);
    values.egressRule = hit ? wantEgress : null;
    egressRuleId = hit?.SecurityGroupRuleId;
  }
  const tags = fromAwsTagList(targetGroup.Tags);
  return {
    ...base,
    externalId: targetId,
    presence: ingressHit ? "present" : "missing",
    attributes: {
      ...attributesOf(ctx, names, values),
      // the rule this node describes does not exist, so its own fields have nothing to read
      ...(ingressHit ? {} : unknownAttributes(["port", "protocol", "source"], "not_applicable", "the ingress rule does not exist")),
    },
    native: boundNative(
      {
        securityGroupId: targetId,
        sourceSecurityGroupId: sourceGroup?.GroupId ?? null,
        groupName: targetGroup.GroupName,
        vpcId: targetGroup.VpcId,
        ingressRuleId: ingressHit?.rule.SecurityGroupRuleId,
        egressRuleId,
        targetIngress: normalizedIngress.map((x) => ruleKey(x.normalized)).sort().slice(0, 40),
        worldOpenIngress: normalizedIngress.filter((x) => isWorldPeer(x.normalized.peer)).map((x) => ruleKey(x.normalized)).sort(),
        rulesTruncated: loaded.truncated,
        tags,
      },
      { priority: NATIVE_PRIORITY }
    ),
  };
}

const tri = (v: unknown): boolean | "unknown" => (v === undefined ? "unknown" : v !== null);

async function verifyFirewall(ctx: AwsDriverContext, node: ResourceNode, observation: Observation) {
  const expected = expectedFirewallAttributes(node);
  const s = specOf(node);
  const wantIngressKey = s.valid ? ruleKey(expectedIngress(s)) : "the ingress rule";
  const checks: VerificationCheck[] = [];
  const sgId = observation.native?.securityGroupId;
  checks.push({
    id: "security_group_exists",
    description: "the target's security group exists",
    passed: typeof sgId === "string" ? true : observation.presence === "missing" ? false : "unknown",
    ...(typeof sgId === "string" ? {} : { detail: observation.error ?? `presence is ${observation.presence}` }),
  });
  if (typeof sgId === "string") {
    const read = (name: string): boolean | "unknown" => {
      const v = observation.attributes[name];
      return v && v.state === "known" ? tri(v.value) : "unknown";
    };
    const ingress: boolean | "unknown" = observation.presence === "present" ? true : observation.presence === "missing" ? false : "unknown";
    checks.push({
      id: "ingress_rule_present",
      description: "the expected ingress rule is on the target's security group",
      passed: ingress,
      ...(ingress === true ? {} : { detail: ingress === false ? `missing: ${wantIngressKey}` : "the rules could not be read" }),
    });
    if ("egressRule" in expected) {
      const egress = read("egressRule");
      checks.push({
        id: "egress_rule_present",
        description: "the companion egress rule is on the source's security group",
        passed: egress,
        ...(egress === true ? {} : { detail: egress === false ? `missing: ${String(expected.egressRule)}` : "the rules could not be read" }),
      });
    }
    const target = (node.spec as PartialFirewall).target;
    const world = observation.native?.worldOpenIngress;
    if (typeof target === "string" && !target.startsWith("load_balancer/") && Array.isArray(world)) {
      const unexpected = world.filter((k) => k !== wantIngressKey);
      checks.push({
        id: "no_unexpected_public_ingress",
        description: "no ingress on the target is open to the whole internet",
        passed: unexpected.length === 0,
        ...(unexpected.length === 0 ? {} : { detail: `open to the internet: ${unexpected.join("; ")}` }),
      });
    }
  }
  return verificationResult(ctx, node, checks);
}

const inspect: NativeOperation<AwsSession> = async (ctx, node, input) => {
  const spec = specOf(node);
  if (!spec.valid) return { ok: false, summary: "the firewall spec has no usable target, port or source", simulated: false };
  const which = input.group === "source" ? "source" : "target";
  if (which === "source" && !isSourceAddress(spec)) return { ok: false, summary: "this rule's source is a CIDR, not a security group", simulated: false };
  const address = which === "source" ? (spec as FirewallSpec & { source: { address: string } }).source.address : spec.target;
  const ec2 = ctx.session.client(EC2Client);
  try {
    const groups = await findSecurityGroups(ctx, ec2, address);
    if (groups.length === 0) return { ok: false, summary: `no security group is tagged for ${address}`, simulated: false };
    if (groups.length > 1) return { ok: false, summary: `${groups.length} security groups are tagged for ${address}; refusing to pick one`, simulated: false };
    const groupId = groups[0].GroupId as string;
    const loaded = await loadRules(ctx, ec2, [groupId]);
    const peers = await resolvePeerAddresses(ctx, ec2, loaded.rules, new Map([[groupId, address]]));
    const rules: NormalizedRule[] = loaded.rules.map((r) => normalizeRule(r, peers));
    const dir = which === "source" ? "egress" : "ingress";
    const expectedKeys = which === "source" ? [ruleKey(expectedEgress(spec) as NormalizedRule)] : [ruleKey(expectedIngress(spec))];
    const diff = diffRuleSets(expectedKeys, rules.filter((r) => r.direction === dir));
    const keys = (d: "ingress" | "egress") => rules.filter((r) => r.direction === d).map(ruleKey).sort();
    return {
      ok: true,
      summary: `${groupId} (${address}): ${keys("ingress").length} ingress and ${keys("egress").length} egress rules; ${diff.missing.length} expected rule(s) missing`,
      data: {
        securityGroupId: groupId,
        owner: address,
        ingress: keys("ingress").slice(0, MAX_LISTED_RULES),
        egress: keys("egress").slice(0, MAX_LISTED_RULES),
        expected: { present: diff.present, missing: diff.missing },
        // rules on the group this node does not account for; other firewall nodes' rules appear here too
        otherRules: diff.unexpected.slice(0, MAX_LISTED_RULES),
        truncated: loaded.truncated || keys("ingress").length > MAX_LISTED_RULES || keys("egress").length > MAX_LISTED_RULES,
      },
      ...(loaded.requestId ? { requestIds: [loaded.requestId] } : {}),
      simulated: false,
    };
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return { ok: false, summary: `could not read the rules: ${failure.summary}`, ...(failure.requestId ? { requestIds: [failure.requestId] } : {}), simulated: false };
  }
};

async function discoverSecurityGroups(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const ec2 = ctx.session.client(EC2Client);
  const { items } = await paginate(
    async (t) => {
      const r = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: t }), { abortSignal: ctx.signal });
      return { items: r.SecurityGroups ?? [], next: r.NextToken };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  return items
    .filter((g): g is SecurityGroup & { GroupId: string } => typeof g.GroupId === "string")
    .map((g) => ({
      provider: "aws" as const,
      kind: "firewall" as const,
      nativeType: "aws:security_group_rule",
      externalId: g.GroupId,
      name: g.GroupName ?? g.GroupId,
      region: ctx.region,
      zenithTagged: hasZenithManagedTag(fromAwsTagList(g.Tags)),
      attributes: { vpcId: g.VpcId ?? "", ingressRules: g.IpPermissions?.length ?? 0, egressRules: g.IpPermissionsEgress?.length ?? 0 },
    }));
}

export const securityGroupRuleDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "firewall",
  nativeType: "aws:security_group_rule",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: ["firewall.inspect"],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract", "firewall.inspect": "contract" },
  },
  compile: compileFirewall,
  observe: observeFirewall,
  expectedAttributes: expectedFirewallAttributes,
  verify: verifyFirewall,
  discover: discoverSecurityGroups,
  operations: { "firewall.inspect": inspect },
};
