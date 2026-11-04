/**
 * Read-only EC2 lookups for security groups and their rules, shared by the
 * firewall driver's `observe`, `verify` and `firewall.inspect`.
 *
 * Groups are found by `externalId` (a `sg-…` id Zenith recorded) or by the
 * Zenith tags of the OWNING node — never by group name. Rules come from
 * DescribeSecurityGroupRules filtered by `group-id`, paginated with a bound.
 * Peers that reference another group are mapped back to the owning node's
 * address through that group's `zenith:resource` tag, so a rule reads
 * `sg:load_balancer/public` whatever the group id is.
 */
import {
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  type SecurityGroup,
  type SecurityGroupRule,
} from "@aws-sdk/client-ec2";
import { type AwsDriverContext, TAG_RESOURCE, chunk, ec2TagFilters, fromAwsTagList, matchesNodeTags, paginate } from "../shared";

export const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/;
const MAX_RULE_PAGES = 10;
const MAX_PEER_LOOKUP = 40;

/** Groups of the node at `address` (by `externalId` when it is a sg id, else by tags). Zero, one, or more than one. */
export async function findSecurityGroups(ctx: AwsDriverContext, ec2: EC2Client, address: string, externalId?: string): Promise<SecurityGroup[]> {
  const input = externalId !== undefined && SECURITY_GROUP_ID.test(externalId) ? { GroupIds: [externalId] } : { Filters: ec2TagFilters(ctx, address) };
  const { items } = await paginate(
    async (t) => {
      const r = await ec2.send(new DescribeSecurityGroupsCommand({ ...input, NextToken: t }), { abortSignal: ctx.signal });
      return { items: r.SecurityGroups ?? [], next: r.NextToken };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  return items;
}

/** Every rule (ingress and egress) of the given groups. `truncated` when the page bound was hit. */
export async function loadRules(ctx: AwsDriverContext, ec2: EC2Client, groupIds: string[]): Promise<{ rules: SecurityGroupRule[]; truncated: boolean; requestId?: string }> {
  let requestId: string | undefined;
  const res = await paginate(
    async (t) => {
      const r = await ec2.send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "group-id", Values: groupIds }], NextToken: t }), { abortSignal: ctx.signal });
      requestId ??= r.$metadata?.requestId;
      return { items: r.SecurityGroupRules ?? [], next: r.NextToken };
    },
    { maxPages: MAX_RULE_PAGES, signal: ctx.signal }
  );
  return { rules: res.items, truncated: res.truncated, ...(requestId ? { requestId } : {}) };
}

/**
 * `known` plus the address of every referenced group in `rules` that carries
 * this environment's `zenith:resource` tag. Best effort: a failed or denied
 * lookup leaves those peers as raw `sg-…` ids, which is still truthful.
 */
export async function resolvePeerAddresses(ctx: AwsDriverContext, ec2: EC2Client, rules: SecurityGroupRule[], known: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const out = new Map(known);
  const unknownIds = [...new Set(rules.map((r) => r.ReferencedGroupInfo?.GroupId).filter((g): g is string => typeof g === "string" && !out.has(g)))].slice(0, MAX_PEER_LOOKUP);
  for (const ids of chunk(unknownIds, 20)) {
    try {
      const r = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: ids }), { abortSignal: ctx.signal });
      for (const g of r.SecurityGroups ?? []) {
        const tags = fromAwsTagList(g.Tags);
        const address = tags[TAG_RESOURCE];
        if (g.GroupId && address && matchesNodeTags(tags, ctx, address)) out.set(g.GroupId, address);
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      break;
    }
  }
  return out;
}
