import { CloudWatchLogsClient, DescribeLogGroupsCommand, ListTagsForResourceCommand, type LogGroup } from "@aws-sdk/client-cloudwatch-logs";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cloudwatchLogGroupDriver as driver } from "@/lib/providers/aws/drivers/data";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { ALLOWED_RETENTION_DAYS, cleanLogGroupArn, logGroupNameOf, retentionDaysFor } from "@/lib/providers/aws/drivers/data/cloudwatch-log-group";
import { driftOf } from "./_drift";
import { awsError, compileCtx, driverCtx, mkNode, tagRecord } from "./_helpers";

const logs = mockClient(CloudWatchLogsClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  logs.reset();
  tagging.reset();
});
afterAll(() => {
  logs.restore();
  tagging.restore();
});

const node = mkNode("log_group/web", "log_group", { workload: "container_service/web", retentionDays: 30 });
const build = (retentionDays: unknown, over: Partial<typeof node> = {}) => mkNode("log_group/web", "log_group", { workload: "container_service/web", retentionDays }, over);
const compile = (n = node) => driver.compile!(n, compileCtx([n]));
type Body = Record<string, unknown>;
const group = (f: ReturnType<typeof compile>): Body => (f.resource!.aws_cloudwatch_log_group as Record<string, Body>).log_group_web;

describe("aws:cloudwatch_log_group compile", () => {
  it("defines one log group with the spec's retention, Zenith tags and a deterministic name", () => {
    const f = compile();
    expect(f.addresses).toEqual(["aws_cloudwatch_log_group.log_group_web"]);
    expect(group(f)).toMatchObject({ name: "/zenith/zen-prod-web", retention_in_days: 30 });
    expect((group(f).tags as Record<string, string>)["zenith:resource"]).toBe("log_group/web");
    expect(group(f)).not.toHaveProperty("kms_key_id");
  });

  it.each([
    [1, 1],
    [30, 30],
    [45, 60],
    [100, 120],
    [366, 400],
    [3653, 3653],
    [99999, 3653],
  ])("retentionDays %i compiles to %i: rounded UP to a value CloudWatch accepts, capped at 3653", (days, compiled) => {
    expect(group(compile(build(days))).retention_in_days).toBe(compiled);
    expect(ALLOWED_RETENTION_DAYS).toContain(compiled);
    expect(driver.expectedAttributes!(build(days))).toEqual({ retentionDays: compiled });
  });

  it.each([[0], [-5], [Number.NaN], ["30"], [undefined], [null]])("refuses retentionDays %j", (days) => {
    expect(() => retentionDaysFor(build(days))).toThrow(DriverCompileError);
    // drift stays computable for an invalid spec: nothing is expected rather than a throw
    expect(driver.expectedAttributes!(build(days))).toEqual({});
  });

  it("publishes arn, id and name; is deterministic; non-managed groups compile to nothing", () => {
    expect(Object.keys(compile().locals!).sort()).toEqual(["ref_log_group_web__arn", "ref_log_group_web__id", "ref_log_group_web__name"]);
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    expect(compile(build(30, { ownership: "referenced" }))).toEqual({ addresses: [] });
  });
});

const NAME = "/zenith/zen-prod-web";
const ARN = `arn:aws:logs:ap-south-1:123456789012:log-group:${NAME}`;
const lg = (over: Partial<LogGroup> = {}): LogGroup => ({ logGroupName: NAME, arn: `${ARN}:*`, retentionInDays: 30, storedBytes: 1024, logGroupClass: "STANDARD", ...over });

describe("aws:cloudwatch_log_group observe", () => {
  it("reads the exact group (prefix matches are ignored), strips the :* suffix and carries logGroupName and tags", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg({ logGroupName: `${NAME}-other`, arn: `${ARN}-other:*` }), lg()] });
    logs.on(ListTagsForResourceCommand).resolves({ tags: tagRecord("log_group/web") });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.cloudwatch_log_group@1" });
    expect(obs.native).toMatchObject({ logGroupName: NAME });
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:managed"]).toBe("true");
    expect(logs.commandCalls(DescribeLogGroupsCommand)[0].args[0].input).toMatchObject({ logGroupNamePrefix: NAME });
    expect(logs.commandCalls(ListTagsForResourceCommand)[0].args[0].input).toEqual({ resourceArn: ARN });
    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
  });

  it("accepts an ARN with or without :* and a bare name", async () => {
    expect(logGroupNameOf(`${ARN}:*`)).toBe(NAME);
    expect(logGroupNameOf(ARN)).toBe(NAME);
    expect(logGroupNameOf(NAME)).toBe(NAME);
    expect(logGroupNameOf("arn:aws:s3:::b")).toBeUndefined();
    expect(logGroupNameOf("bad name")).toBeUndefined();
    expect(cleanLogGroupArn(`${ARN}:*`)).toBe(ARN);
    const obs = await driver.observe!(driverCtx(), node, "bad name");
    expect(obs.presence).toBe("unknown");
    expect(logs.calls()).toHaveLength(0);
  });

  it("reports never-expire retention as 0 and flags it as drift", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg({ retentionInDays: undefined })] });
    logs.on(ListTagsForResourceCommand).resolves({ tags: {} });
    const obs = await driver.observe!(driverCtx(), node, NAME);
    expect(obs.attributes.retentionDays).toMatchObject({ state: "known", value: 0 });
    expect(driftOf(node, obs, driver.expectedAttributes!)[0].fields).toEqual([{ attribute: "retentionDays", desired: 30, observed: 0 }]);
  });

  it("an empty DescribeLogGroups result means missing; it never matches a different group by prefix", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg({ logGroupName: `${NAME}2`, arn: `${ARN}2:*` })] });
    const obs = await driver.observe!(driverCtx(), node, NAME);
    expect(obs.presence).toBe("missing");
    expect(obs.attributes.retentionDays).toMatchObject({ state: "unknown", reason: "not_applicable" });
  });

  it("classifies AccessDenied and throttling; keeps the observation when only the tag read fails", async () => {
    logs.on(DescribeLogGroupsCommand).rejects(awsError("AccessDeniedException", "no", 400));
    expect((await driver.observe!(driverCtx(), node, NAME)).presence).toBe("inaccessible");
    logs.on(DescribeLogGroupsCommand).rejects(awsError("ThrottlingException", "slow", 400));
    expect((await driver.observe!(driverCtx(), node, NAME)).presence).toBe("unknown");
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg()] });
    logs.on(ListTagsForResourceCommand).rejects(awsError("AccessDeniedException", "no", 400));
    const partial = await driver.observe!(driverCtx(), node, NAME);
    expect(partial.presence).toBe("present");
    expect(partial.native).toMatchObject({ tagsUnreadable: "AccessDeniedException" });
  });

  it("finds the group by tags when no id is known, refusing ambiguity", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg()] });
    logs.on(ListTagsForResourceCommand).resolves({ tags: tagRecord("log_group/web") });
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["logs:log-group"]);
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }, { ResourceARN: `${ARN}-2` }] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("unknown");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("missing");
  });

  it("verify: a retention period is required", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg()] });
    logs.on(ListTagsForResourceCommand).resolves({ tags: {} });
    const ctx = driverCtx();
    expect((await driver.verify!(ctx, node, await driver.observe!(ctx, node, NAME))).status).toBe("passed");
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg({ retentionInDays: undefined })] });
    const r = await driver.verify!(ctx, node, await driver.observe!(ctx, node, NAME));
    expect(r.status).toBe("failed");
    expect(r.checks.find((c) => c.id === "retention_set")!.passed).toBe(false);
  });

  it("declares no runtime", () => {
    expect(driver.runtime).toBeUndefined();
    expect(driver.capabilities.runtime).toBe(false);
  });

  it("discover lists groups with :* stripped from ids and Zenith-tagged ones marked", async () => {
    logs.on(DescribeLogGroupsCommand).resolves({ logGroups: [lg(), lg({ logGroupName: "/aws/lambda/fn", arn: "arn:aws:logs:ap-south-1:123456789012:log-group:/aws/lambda/fn:*", retentionInDays: undefined })] });
    logs.on(ListTagsForResourceCommand, { resourceArn: ARN }).resolves({ tags: tagRecord("log_group/web") });
    logs.on(ListTagsForResourceCommand, { resourceArn: "arn:aws:logs:ap-south-1:123456789012:log-group:/aws/lambda/fn" }).resolves({ tags: {} });
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.externalId, f.zenithTagged])).toEqual([
      ["/aws/lambda/fn", "arn:aws:logs:ap-south-1:123456789012:log-group:/aws/lambda/fn", false],
      [NAME, ARN, true],
    ]);
    expect(found[0].attributes).toMatchObject({ retentionDays: 0 });
  });
});
