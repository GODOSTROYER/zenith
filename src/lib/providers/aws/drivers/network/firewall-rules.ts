/**
 * Normalized security-group rules: the vocabulary `aws:security_group_rule`
 * uses for `expectedAttributes`, `observe`, `verify` and `firewall.inspect`.
 *
 * A rule is normalized to (direction, protocol, port range, peer) where the
 * peer is one of
 *   `sg:<zenith address>`   a referenced security group that some Zenith node
 *                           owns (mapped back from the group id by its
 *                           `zenith:resource` tag) — stable across re-creation
 *   `sg:<sg-id>`            a referenced group Zenith does not own
 *   `cidr:<a.b.c.d/n>`      an IPv4 range
 *   `cidr6:<…>`, `pl:<id>`  IPv6 range / managed prefix list
 * and its one-line {@link ruleKey} (`ingress tcp/3000 sg:load_balancer/public`)
 * is what drift compares. Descriptions and tags are deliberately NOT part of
 * the key: editing a description is not a network change.
 *
 * `diffRuleSets` answers "which of the expected rules are present, which are
 * missing, and which observed rules nobody expects" — the question the
 * security-group-break incident scenario asks of a security group.
 */
import type { SecurityGroupRule } from "@aws-sdk/client-ec2";
import type { FirewallSpec } from "@/lib/resources/specs";

export interface NormalizedRule {
  direction: "ingress" | "egress";
  /** `tcp`, `udp`, `icmp`, `icmpv6`, `all`, or a protocol number as a string */
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  peer: string;
}

const PROTOCOL_NAMES: Record<string, string> = { "-1": "all", "6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6" };

function portsOf(r: NormalizedRule): string {
  if (r.fromPort === null && r.toPort === null) return "";
  return r.fromPort === r.toPort ? `/${r.fromPort}` : `/${r.fromPort}-${r.toPort}`;
}

/** `ingress tcp/3000 sg:load_balancer/public` — the comparable identity of a rule. */
export function ruleKey(r: NormalizedRule): string {
  return `${r.direction} ${r.protocol}${portsOf(r)} ${r.peer}`;
}

/** Normalize one `DescribeSecurityGroupRules` entry. `addressBySgId` maps group ids of Zenith-owned groups to node addresses. */
export function normalizeRule(rule: SecurityGroupRule, addressBySgId: ReadonlyMap<string, string>): NormalizedRule {
  const raw = rule.IpProtocol ?? "-1";
  const protocol = PROTOCOL_NAMES[raw] ?? raw;
  const allPorts = protocol === "all" || rule.FromPort === -1 || rule.FromPort === undefined;
  let peer = "unknown";
  if (rule.ReferencedGroupInfo?.GroupId) peer = `sg:${addressBySgId.get(rule.ReferencedGroupInfo.GroupId) ?? rule.ReferencedGroupInfo.GroupId}`;
  else if (rule.CidrIpv4) peer = `cidr:${rule.CidrIpv4}`;
  else if (rule.CidrIpv6) peer = `cidr6:${rule.CidrIpv6}`;
  else if (rule.PrefixListId) peer = `pl:${rule.PrefixListId}`;
  return {
    direction: rule.IsEgress ? "egress" : "ingress",
    protocol,
    fromPort: allPorts ? null : (rule.FromPort ?? null),
    toPort: allPorts ? null : (rule.ToPort ?? null),
    peer,
  };
}

/** The ingress rule a firewall node asks for on its TARGET's security group. */
export function expectedIngress(spec: Pick<FirewallSpec, "port" | "source">): NormalizedRule {
  return { direction: "ingress", protocol: "tcp", fromPort: spec.port, toPort: spec.port, peer: "address" in spec.source ? `sg:${spec.source.address}` : `cidr:${spec.source.cidr}` };
}

/** The egress rule a firewall node asks for on its SOURCE's group (address sources only; a CIDR source is not ours). */
export function expectedEgress(spec: Pick<FirewallSpec, "port" | "source" | "target">): NormalizedRule | undefined {
  if (!("address" in spec.source)) return undefined;
  return { direction: "egress", protocol: "tcp", fromPort: spec.port, toPort: spec.port, peer: `sg:${spec.target}` };
}

export interface RuleDiff {
  present: string[];
  missing: string[];
  /** observed rules no expected rule accounts for */
  unexpected: string[];
}

/** Compare expected rule keys with the observed rules (sorted, deduplicated output). */
export function diffRuleSets(expected: readonly string[], observed: readonly NormalizedRule[]): RuleDiff {
  const seen = new Set(observed.map(ruleKey));
  const want = new Set(expected);
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
  return {
    present: sorted([...want].filter((k) => seen.has(k))),
    missing: sorted([...want].filter((k) => !seen.has(k))),
    unexpected: sorted([...seen].filter((k) => !want.has(k))),
  };
}

/** True for a peer that is the whole internet. */
export const isWorldPeer = (peer: string): boolean => peer === "cidr:0.0.0.0/0" || peer === "cidr6:::/0";
