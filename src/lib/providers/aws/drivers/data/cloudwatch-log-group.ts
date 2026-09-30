/**
 * `aws:cloudwatch_log_group` driver (kind `log_group`).
 *
 * Compile: one `aws_cloudwatch_log_group` named `/zenith/<namePrefix>/<node
 * name>` with `retention_in_days` from `LogGroupSpec.retentionDays`. CloudWatch
 * Logs accepts only a fixed set of retention values, so a value that is not one
 * is ROUNDED UP to the next allowed one (more retention, never less), values
 * above 3653 days are capped, and a non-positive or non-numeric value is
 * refused. `expectedAttributes.retentionDays` uses the same rounding, so drift
 * never reports the rounding itself as a change.
 *
 * Encryption: log data is encrypted at rest with AWS-owned keys. A
 * customer-managed KMS key is not offered because `LogGroupSpec` has no field
 * for one (proposed additive field: `kmsKeyRef`); nothing reads a key from
 * anywhere else.
 *
 * Observe: DescribeLogGroups filtered to the exact name (the API matches by
 * prefix, so other groups sharing the prefix are ignored) + ListTagsForResource.
 * `Observation.externalId` is the log group ARN (without the `:*` suffix the
 * API sometimes appends); `native.logGroupName` and `native.tags` are carried
 * for observability and drift. No runtime: a log group has no serving state.
 *
 * Honest limits: `contract` evidence only; the tag lookup used when
 * `externalId` is unknown goes through the eventually consistent tagging index.
 */
import { DescribeLogGroupsCommand, CloudWatchLogsClient, ListTagsForResourceCommand, type LogGroup } from "@aws-sdk/client-cloudwatch-logs";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { cloudName, DriverCompileError, FragmentBuilder, isArnOf, nodeName, paginate, parseArn, REF, resourceTags, tfLabel } from "./_shared";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  call,
  candidate,
  EMPTY_FRAGMENT,
  expectedFor,
  findByTags,
  guardObserve,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  safeTags,
  scalars,
  tagMap,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
} from "./support";

export const LOG_GROUP_SOURCE = "aws.cloudwatch_log_group@1";

/** The retention values CloudWatch Logs accepts (days). */
export const ALLOWED_RETENTION_DAYS: readonly number[] = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

const LOG_GROUP_NAME = /^[\w./#-]{1,512}$/;

/** Round `days` up to the next retention CloudWatch accepts (cap 3653); refuse non-positive or non-numeric input. */
export function retentionDaysFor(node: ResourceNode): number {
  const raw = (node.spec as { retentionDays?: unknown }).retentionDays;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new DriverCompileError("invalid_spec", node.address, "spec.retentionDays must be a positive number of days.");
  }
  return ALLOWED_RETENTION_DAYS.find((d) => d >= raw) ?? ALLOWED_RETENTION_DAYS[ALLOWED_RETENTION_DAYS.length - 1];
}

export const logGroupNameFor = (ctx: Pick<CompileContext, "namePrefix">, address: string): string => `/zenith/${cloudName(ctx.namePrefix, nodeName(address), 200)}`;

export function compileLogGroup(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const label = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  b.resource("aws_cloudwatch_log_group", label, {
    name: logGroupNameFor(ctx, node.address),
    retention_in_days: retentionDaysFor(node),
    tags: safeTags(resourceTags(ctx.tags, node.address)),
  });
  b.expose(REF.arn, `aws_cloudwatch_log_group.${label}.arn`);
  b.expose(REF.id, `aws_cloudwatch_log_group.${label}.id`);
  b.expose("name", `aws_cloudwatch_log_group.${label}.name`);
  b.output(`${label}_arn`, `\${aws_cloudwatch_log_group.${label}.arn}`);
  b.output(`${label}_name`, `\${aws_cloudwatch_log_group.${label}.name}`);
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["retentionDays"] as const;
const INFORMATIONAL_NAMES = ["kmsEncrypted", "storedBytes", "logGroupClass"] as const;
export const LOG_GROUP_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedLogGroupAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => ({ retentionDays: retentionDaysFor(node) }));
}

/** The ARN without the `:*` suffix the API sometimes appends. */
export const cleanLogGroupArn = (arn: string): string => arn.replace(/:\*$/, "");

/** The log group name from an ARN (`arn:…:log-group:<name>[:*]`) or a bare name. */
export function logGroupNameOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "logs", "log-group")) return undefined;
    const name = cleanLogGroupArn(parseArn(externalId)?.resource ?? "").slice("log-group:".length);
    return LOG_GROUP_NAME.test(name) ? name : undefined;
  }
  return LOG_GROUP_NAME.test(externalId) ? externalId : undefined;
}

async function exactGroup(ctx: AwsDriverContext, name: string): Promise<LogGroup | undefined> {
  const logs = ctx.session.client(CloudWatchLogsClient);
  const { items } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) => logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name, ...(token ? { nextToken: token } : {}) }), o));
      return { items: out.logGroups ?? [], next: out.nextToken || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  return items.find((g) => g.logGroupName === name);
}

async function observeLogGroup(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    LOG_GROUP_SOURCE,
    LOG_GROUP_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      let name = logGroupNameOf(externalId);
      if (externalId !== undefined && externalId !== "" && name === undefined) return { kind: "ambiguous", detail: "externalId is not a log group ARN or name" };
      if (name === undefined) {
        const { matches } = await findByTags(ctx, node, "logs:log-group");
        const names = matches.flatMap((m) => {
          const n = logGroupNameOf(m.arn);
          return n ? [n] : [];
        });
        if (names.length === 0) return { kind: "missing" };
        if (names.length > 1) return { kind: "ambiguous", detail: `${names.length} log groups carry the Zenith tags for ${node.address}; refusing to choose one` };
        name = names[0];
      }
      const group = await exactGroup(ctx, name);
      if (!group) return { kind: "missing", detail: `no log group named ${name}` };

      const a = new Attributes(ctx);
      // An absent retention means "never expire": report it as 0, which no spec value can equal.
      a.set("retentionDays", group.retentionInDays ?? 0);
      a.set("kmsEncrypted", group.kmsKeyId !== undefined && group.kmsKeyId !== "");
      a.set("storedBytes", group.storedBytes);
      a.set("logGroupClass", group.logGroupClass);

      const arn = group.arn ? cleanLogGroupArn(group.arn) : undefined;
      let tags: Record<string, string> | undefined;
      let tagsFailure: string | undefined;
      if (arn) {
        try {
          const logs = ctx.session.client(CloudWatchLogsClient);
          tags = tagMap((await call(ctx, (o) => logs.send(new ListTagsForResourceCommand({ resourceArn: arn }), o))).tags);
        } catch (err) {
          const f = classifyAwsError(err, ctx.signal);
          if (f.kind === "aborted") throw err;
          tagsFailure = f.code;
        }
      }
      return {
        kind: "present",
        externalId: arn ?? name,
        attributes: a.finish(LOG_GROUP_ATTRIBUTE_NAMES),
        native: { logGroupName: name, ...(tags ? { tags } : { tagsUnreadable: tagsFailure ?? "no_arn" }) },
      };
    },
    ["tags", "logGroupName"]
  );
}

/* -------------------------------- discover --------------------------------- */

async function discoverLogGroups(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const logs = ctx.session.client(CloudWatchLogsClient);
  const { items } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) => logs.send(new DescribeLogGroupsCommand({ limit: 50, ...(token ? { nextToken: token } : {}) }), o));
      return { items: out.logGroups ?? [], next: out.nextToken || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const g of items) {
    if (!g.logGroupName || !g.arn) continue;
    const arn = cleanLogGroupArn(g.arn);
    let tags: Record<string, string> | undefined;
    if (reads < MAX_TAG_READS) {
      reads++;
      try {
        tags = tagMap((await call(ctx, (o) => logs.send(new ListTagsForResourceCommand({ resourceArn: arn }), o))).tags);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
      }
    }
    found.push(
      candidate(ctx, {
        kind: "log_group",
        nativeType: "aws:cloudwatch_log_group",
        externalId: arn,
        name: g.logGroupName,
        ...(tags ? { tags } : {}),
        attributes: scalars({ retentionDays: g.retentionInDays ?? 0, storedBytes: g.storedBytes, kmsEncrypted: g.kmsKeyId !== undefined, tagsRead: tags !== undefined }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const cloudwatchLogGroupDriver: ResourceDriver<AwsSession> = {
  id: LOG_GROUP_SOURCE,
  provider: "aws",
  kind: "log_group",
  nativeType: "aws:cloudwatch_log_group",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileLogGroup,
  observe: observeLogGroup,
  expectedAttributes: expectedLogGroupAttributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "retention_set", "a retention period is set (the group does not keep logs forever)", "retentionDays", (v) => typeof v === "number" && v > 0),
      matchesExpectedCheck(expectedLogGroupAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverLogGroups,
};
