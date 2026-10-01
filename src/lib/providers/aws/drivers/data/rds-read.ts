/**
 * Shared lookup for the RDS driver's read paths and its day-two operations:
 * resolve the node's instance by provider id when known, else by the Zenith
 * tags on the instance's own `TagList` (never by name alone).
 */
import { DescribeDBInstancesCommand, RDSClient, type DBInstance } from "@aws-sdk/client-rds";
import { isArnOf, paginate, parseArn } from "@/lib/providers/aws/drivers/shared";
import { call, tagMap, tagsMatchNode, validId, type AwsDriverContext } from "./support";
import type { ResourceNode } from "@/lib/resources/types";

export const RDS_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

/** The provider identifier from an ARN or a bare identifier; `undefined` when it is neither. */
export function rdsIdentifierOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "rds", "db")) return undefined;
    return validId(parseArn(externalId)?.resource.slice(3), RDS_IDENTIFIER);
  }
  return validId(externalId, RDS_IDENTIFIER);
}

export async function describeInstance(ctx: AwsDriverContext, identifier: string): Promise<DBInstance | undefined> {
  const rds = ctx.session.client(RDSClient);
  const out = await call(ctx, (o) => rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }), o));
  return out.DBInstances?.[0];
}

/** The instances whose own tags identify this node. Bounded scan; strongly consistent (tags ride on the instance). */
export async function findInstancesByTags(ctx: AwsDriverContext, node: ResourceNode): Promise<{ matches: DBInstance[]; truncated: boolean }> {
  const rds = ctx.session.client(RDSClient);
  const { items, truncated } = await paginate(
    async (marker) => {
      const out = await call(ctx, (o) => rds.send(new DescribeDBInstancesCommand({ MaxRecords: 100, ...(marker ? { Marker: marker } : {}) }), o));
      return { items: out.DBInstances ?? [], next: out.Marker || undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  return { matches: items.filter((i) => tagsMatchNode(tagMap(i.TagList), ctx, node)), truncated };
}

export type ResolvedInstance = DBInstance | "missing" | { ambiguous: string };

/**
 * Resolve the node's instance: by id when known, else by Zenith tags. Zero
 * matches is `missing`; more than one, or an `externalId` that is not an RDS
 * identifier, is `ambiguous` (refusing to guess).
 */
export async function resolveInstance(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<ResolvedInstance> {
  const identifier = rdsIdentifierOf(externalId);
  if (externalId !== undefined && externalId !== "" && identifier === undefined) return { ambiguous: "externalId is not an RDS instance ARN or identifier" };
  if (identifier !== undefined) return (await describeInstance(ctx, identifier)) ?? "missing";
  const { matches, truncated } = await findInstancesByTags(ctx, node);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: `${matches.length} instances carry the Zenith tags for ${node.address}; refusing to choose one` };
  return truncated ? { ambiguous: "no instance with the Zenith tags was found in the first pages of the account; the inventory was not complete" } : "missing";
}
