/**
 * AWS-side helpers for the live scenarios. Everything here uses the run's own
 * `AwsAccess` (the operator's ambient sandbox credentials) and exists for two
 * jobs: independent VERIFICATION (what is really in the account, not what the
 * control plane says) and out-of-band CHANGES that stand in for the outside
 * world (a person editing a security group, an autoscaler changing a count).
 *
 * Every out-of-band change goes through `guardedChange`, which re-reads the
 * target's tags and refuses unless it carries THIS run's `zenith:live-run` tag.
 */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { DescribeSecurityGroupsCommand, EC2Client, type IpPermission } from "@aws-sdk/client-ec2";
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { TAG_ENVIRONMENT } from "@/lib/credentials/aws/naming";
import { TAG_LIVE_RUN, assertTaggedForRun } from "../safety";
import { awsOf, type ScenarioContext } from "../types";

/** ARNs of resources of one tagging-API type (e.g. `ec2:security-group`) that belong to this run. */
export async function runResourcesOfType(ctx: ScenarioContext, resourceType: string): Promise<string[]> {
  const aws = awsOf(ctx);
  const tagging = aws.client(ResourceGroupsTaggingAPIClient);
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const page = await tagging.send(new GetResourcesCommand({ TagFilters: [{ Key: TAG_LIVE_RUN, Values: [ctx.runId] }], ResourceTypeFilters: [resourceType], PaginationToken: token }));
    token = page.PaginationToken || undefined;
    for (const r of page.ResourceTagMappingList ?? []) if (r.ResourceARN) arns.push(r.ResourceARN);
  } while (token);
  return arns;
}

/** How many resources currently carry this environment's tag (before adoption they carry no run tag). */
export async function countEnvironmentResources(ctx: ScenarioContext, environmentId: string): Promise<number> {
  const tagging = awsOf(ctx).client(ResourceGroupsTaggingAPIClient);
  let n = 0;
  let token: string | undefined;
  do {
    const page = await tagging.send(new GetResourcesCommand({ TagFilters: [{ Key: TAG_ENVIRONMENT, Values: [environmentId] }], PaginationToken: token }));
    token = page.PaginationToken || undefined;
    n += page.ResourceTagMappingList?.length ?? 0;
  } while (token);
  return n;
}

/**
 * Run an out-of-band change on one resource, after verifying that resource is
 * this run's. The one door every harness-originated mutation goes through.
 */
export async function guardedChange<T>(ctx: ScenarioContext, arn: string, change: () => Promise<T>): Promise<T> {
  await assertTaggedForRun(awsOf(ctx).client(ResourceGroupsTaggingAPIClient), arn, ctx.runId);
  return change();
}

export interface DbSecurityGroup {
  arn: string;
  groupId: string;
  /** the rules that allow the database port: the ones the break removes and the fix restores */
  dbRules: IpPermission[];
}

/** The run's security group that allows TCP `port` in (the database's group). Throws if there is not exactly one. */
export async function findDbSecurityGroup(ctx: ScenarioContext, port = 5432): Promise<DbSecurityGroup> {
  const aws = awsOf(ctx);
  const arns = await runResourcesOfType(ctx, "ec2:security-group");
  const ec2 = aws.client(EC2Client);
  const found: DbSecurityGroup[] = [];
  for (const arn of arns) {
    const groupId = arn.slice(arn.lastIndexOf("/") + 1);
    const out = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
    const rules = (out.SecurityGroups?.[0]?.IpPermissions ?? []).filter((p) => p.IpProtocol === "tcp" && p.FromPort !== undefined && p.FromPort <= port && (p.ToPort ?? p.FromPort) >= port);
    if (rules.length > 0) found.push({ arn, groupId, dbRules: rules });
  }
  if (found.length !== 1) throw new Error(`Expected exactly one run security group allowing tcp/${port}, found ${found.length}.`);
  return found[0]!;
}

/** Current rules of a group that allow `port`, for comparing before and after. */
export async function currentPortRules(ctx: ScenarioContext, groupId: string, port = 5432): Promise<IpPermission[]> {
  const out = await awsOf(ctx).client(EC2Client).send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
  return (out.SecurityGroups?.[0]?.IpPermissions ?? []).filter((p) => p.IpProtocol === "tcp" && p.FromPort !== undefined && p.FromPort <= port && (p.ToPort ?? p.FromPort) >= port);
}

/** A stable string for a rule set, independent of ordering, for equality checks. */
export function ruleSignature(rules: readonly IpPermission[]): string {
  return JSON.stringify(
    rules
      .map((r) => ({
        proto: r.IpProtocol,
        from: r.FromPort,
        to: r.ToPort,
        cidrs: (r.IpRanges ?? []).map((x) => x.CidrIp).sort(),
        groups: (r.UserIdGroupPairs ?? []).map((g) => g.GroupId).sort(),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/** Recent log lines of every log group under `/zenith/<environmentId>/` (redaction happens in the evidence recorder). */
export async function recentEnvironmentLogs(ctx: ScenarioContext, environmentId: string, opts: { sinceMs: number; filter?: string; limit?: number }): Promise<{ groups: string[]; lines: string[] }> {
  const logs = awsOf(ctx).client(CloudWatchLogsClient);
  const prefix = `/zenith/${environmentId}/`;
  const groups = ((await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }))).logGroups ?? []).flatMap((g) => (g.logGroupName ? [g.logGroupName] : []));
  const lines: string[] = [];
  for (const logGroupName of groups) {
    const out = await logs.send(new FilterLogEventsCommand({ logGroupName, startTime: ctx.now().getTime() - opts.sinceMs, filterPattern: opts.filter, limit: opts.limit ?? 50 }));
    for (const e of out.events ?? []) if (e.message) lines.push(e.message.trim());
  }
  return { groups, lines };
}
