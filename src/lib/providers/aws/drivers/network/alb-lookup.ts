/**
 * Read-only ELBv2 lookups: find the node's load balancer, its target groups
 * and their Zenith tags.
 *
 * ELBv2 has no tag filter on DescribeLoadBalancers, so a load balancer is found
 * by `externalId` (its ARN) or — when that is not known — by listing (bounded)
 * and matching the Zenith tags through DescribeTags, 20 ARNs at a time. Never by
 * name alone.
 */
import {
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  type LoadBalancer,
  type TargetGroup,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { type AwsDriverContext, chunk, fromAwsTagList, isArnOf, matchesNodeTags, paginate } from "../shared";

export const MAX_LB_PAGES = 5;
const DESCRIBE_TAGS_BATCH = 20;

/** Tags by resource ARN, for any ELBv2 resources, in batches of 20. */
export async function loadTags(ctx: AwsDriverContext, elb: ElasticLoadBalancingV2Client, arns: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (const batch of chunk(arns, DESCRIBE_TAGS_BATCH)) {
    const r = await elb.send(new DescribeTagsCommand({ ResourceArns: batch }), { abortSignal: ctx.signal });
    for (const d of r.TagDescriptions ?? []) if (d.ResourceArn) out.set(d.ResourceArn, fromAwsTagList(d.Tags));
  }
  return out;
}

export interface FoundLoadBalancer {
  /** exactly one match, or undefined */
  lb?: LoadBalancer;
  tags?: Record<string, string>;
  /** how many load balancers matched (0 = missing, >1 = ambiguous) */
  matches: number;
  /** the list was cut at the page bound; a "missing" answer is then only "not in the first pages" */
  truncated: boolean;
}

export async function findLoadBalancer(ctx: AwsDriverContext, elb: ElasticLoadBalancingV2Client, address: string, externalId?: string): Promise<FoundLoadBalancer> {
  if (externalId !== undefined && isArnOf(externalId, "elasticloadbalancing", "loadbalancer")) {
    const r = await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [externalId] }), { abortSignal: ctx.signal });
    const lb = r.LoadBalancers?.[0];
    if (!lb?.LoadBalancerArn) return { matches: 0, truncated: false };
    const tags = (await loadTags(ctx, elb, [lb.LoadBalancerArn])).get(lb.LoadBalancerArn) ?? {};
    return { lb, tags, matches: 1, truncated: false };
  }
  const listed = await paginate(
    async (m) => {
      const r = await elb.send(new DescribeLoadBalancersCommand({ Marker: m, PageSize: 100 }), { abortSignal: ctx.signal });
      return { items: r.LoadBalancers ?? [], next: r.NextMarker };
    },
    { maxPages: MAX_LB_PAGES, signal: ctx.signal }
  );
  const apps = listed.items.filter((l): l is LoadBalancer & { LoadBalancerArn: string } => typeof l.LoadBalancerArn === "string" && l.Type === "application");
  const tags = await loadTags(ctx, elb, apps.map((l) => l.LoadBalancerArn));
  const hits = apps.filter((l) => matchesNodeTags(tags.get(l.LoadBalancerArn) ?? {}, ctx, address));
  return { ...(hits.length === 1 ? { lb: hits[0], tags: tags.get(hits[0].LoadBalancerArn) } : {}), matches: hits.length, truncated: listed.truncated };
}

/** Target groups attached to the load balancer (those a listener rule forwards to). */
export async function loadTargetGroups(ctx: AwsDriverContext, elb: ElasticLoadBalancingV2Client, lbArn: string): Promise<TargetGroup[]> {
  const { items } = await paginate(
    async (m) => {
      const r = await elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn, Marker: m, PageSize: 100 }), { abortSignal: ctx.signal });
      return { items: r.TargetGroups ?? [], next: r.NextMarker };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  return items;
}
