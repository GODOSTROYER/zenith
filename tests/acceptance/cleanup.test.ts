/** Sweeper tests use aws-sdk-client-mock only. No AWS resources are touched. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { ECSClient, DescribeServicesCommand, UpdateServiceCommand, DeleteServiceCommand } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DeleteLoadBalancerCommand, DeleteTargetGroupCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { RDSClient, DescribeDBInstancesCommand, DeleteDBInstanceCommand } from "@aws-sdk/client-rds";
import { ElastiCacheClient, DescribeReplicationGroupsCommand, DeleteReplicationGroupCommand } from "@aws-sdk/client-elasticache";
import { EC2Client, DescribeSecurityGroupsCommand, DescribeVpcsCommand, DeleteSubnetCommand, DeleteSecurityGroupCommand, DeleteVpcCommand } from "@aws-sdk/client-ec2";
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { cleanupRuns } from "../../scripts/acceptance/cleanup";
import { runCleanupCli } from "../../scripts/acceptance/cleanup-cli";
import { resolveHandler } from "../../scripts/acceptance/cleanup-handlers";
import { parseArn, type HandlerCtx, type Handler } from "../../scripts/acceptance/cleanup-util";
import { newRunState } from "../../scripts/acceptance/run-state";
import { liveRunTags } from "../../scripts/acceptance/safety";
import { ACCOUNT, access, REGION, RUN, temp } from "./_helpers";

const tag = mockClient(ResourceGroupsTaggingAPIClient), ecs = mockClient(ECSClient), elb = mockClient(ElasticLoadBalancingV2Client), rds = mockClient(RDSClient), cache = mockClient(ElastiCacheClient), ec2 = mockClient(EC2Client), s3 = mockClient(S3Client), sts = mockClient(STSClient), ssm = mockClient(SSMClient);
const mocks = [tag, ecs, elb, rds, cache, ec2, s3, sts, ssm];
afterEach(() => { for (const m of mocks) m.reset(); });
const arn = (service: string, resource: string, account = ACCOUNT) => `arn:aws:${service}:${REGION}:${account}:${resource}`;
const bucketArn = `arn:aws:s3:::zenith-${RUN}-bucket`;
const mapping = (ResourceARN: string, runId = RUN) => ({ ResourceARN, Tags: [{ Key: "zenith:live-run", Value: runId }] });
const base = () => ({ access: access(), selector: { runId: RUN }, useTofu: false, sleep: async () => undefined, pollMs: 1, waitTimeoutMs: 100 });
const handlerCtx = (): HandlerCtx => ({ access: access(), runId: RUN, listedRegion: REGION, sleep: async () => undefined, pollMs: 1, waitTimeoutMs: 100, now: Date.now, log: () => undefined });
function listing(resources: string[], fresh?: (a: string) => ReturnType<typeof mapping>[]) {
  let lists = 0;
  tag.on(GetResourcesCommand).callsFake((input) => {
    if (input.ResourceARNList) return { ResourceTagMappingList: fresh ? fresh(input.ResourceARNList[0]) : [mapping(input.ResourceARNList[0])] };
    return { ResourceTagMappingList: lists++ === 0 ? resources.map((r) => mapping(r)) : [] };
  });
}
describe("cleanup boundary and dependency order", () => {
  it("dry-run by default issues no delete or tag mutation", async () => {
    listing([bucketArn, arn("rds", `db:zenith-${RUN}-db`)]);
    const report = await cleanupRuns(base()); expect(report.mode).toBe("dry-run"); expect(report.summary.wouldDelete).toBe(2);
    for (const m of [ecs, elb, rds, cache, ec2, s3]) expect(m.calls()).toHaveLength(0);
    expect(tag.calls().every((c) => c.args[0] instanceof GetResourcesCommand)).toBe(true);
  });
  it("deletes a shuffled AWS list in dependency order", async () => {
    const log: string[] = []; const record = (name: string) => () => { log.push(name); return {}; };
    const resources = [arn("ec2", "vpc/vpc-1"), arn("ec2", "security-group/sg-1"), arn("elasticache", `replicationgroup:zenith-${RUN}-cache`), arn("rds", `db:zenith-${RUN}-db`), arn("elasticloadbalancing", `targetgroup/zenith-${RUN}-tg/123`), arn("ec2", "subnet/subnet-1"), arn("elasticloadbalancing", `loadbalancer/app/zenith-${RUN}-alb/123`), arn("ecs", `service/cluster/zenith-${RUN}-web`)];
    listing(resources);
    ecs.on(DescribeServicesCommand).resolvesOnce({ services: [{ status: "ACTIVE" }] }).resolves({ services: [{ status: "INACTIVE" }] }); ecs.on(UpdateServiceCommand).callsFake(record("ecs:update")); ecs.on(DeleteServiceCommand).callsFake(record("ecs:delete"));
    elb.resolves({}); elb.on(DescribeLoadBalancersCommand).resolvesOnce({ LoadBalancers: [{ LoadBalancerArn: resources[6] }] }).resolves({ LoadBalancers: [] }); elb.on(DeleteLoadBalancerCommand).callsFake(record("alb")); elb.on(DeleteTargetGroupCommand).callsFake(record("tg"));
    rds.on(DescribeDBInstancesCommand).resolvesOnce({ DBInstances: [{ DBInstanceStatus: "available" }] }).resolves({ DBInstances: [] }); rds.on(DeleteDBInstanceCommand).callsFake(record("rds"));
    cache.on(DescribeReplicationGroupsCommand).resolvesOnce({ ReplicationGroups: [{ ReplicationGroupId: "cache" }] }).resolves({ ReplicationGroups: [] }); cache.on(DeleteReplicationGroupCommand).callsFake(record("cache"));
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupName: "run-group" }] }); ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ IsDefault: false }] });
    ec2.on(DeleteSubnetCommand).callsFake(record("subnet")); ec2.on(DeleteSecurityGroupCommand).callsFake(record("sg")); ec2.on(DeleteVpcCommand).callsFake(record("vpc"));
    const report = await cleanupRuns({ ...base(), dryRun: false }); expect(report.ok).toBe(true); expect(log).toEqual(["ecs:update", "ecs:delete", "alb", "tg", "rds", "cache", "subnet", "sg", "vpc"]); expect(rds.commandCalls(DeleteDBInstanceCommand)[0]!.args[0].input.SkipFinalSnapshot).toBe(true);
  });
  it.each(["missing", "other"])("rechecks tags and refuses %s ownership", async (kind) => { listing([bucketArn], (a) => kind === "missing" ? [] : [mapping(a, "zlive-202609301200-xxxx")]); const report = await cleanupRuns({ ...base(), dryRun: false }); expect(report.runs[0]?.resources[0]?.status).toBe(kind === "missing" ? "not_listed_on_recheck" : "refused_tag_mismatch"); expect(report.ok).toBe(false); expect(report.summary.alreadyGone).toBe(0); expect(s3.calls()).toHaveLength(0); });
  it("refuses foreign accounts, unsafe names and unsupported types", async () => {
    listing([arn("rds", "db:production"), arn("rds", `db:zenith-${RUN}-db`, "999999999999"), arn("unknown", `thing/zenith-${RUN}`)]);
    const report = await cleanupRuns({ ...base(), dryRun: false }); expect(report.ok).toBe(false); expect(new Set(report.runs[0]?.resources.map((r) => r.status))).toEqual(new Set(["refused_name_guard", "refused_foreign_account", "unsupported"])); expect(rds.calls()).toHaveLength(0);
  });
  it("stateful RDS handler refuses wrong tags before SkipFinalSnapshot", async () => { const a = parseArn(arn("rds", `db:zenith-${RUN}-db`))!; const h = resolveHandler(a)!.handler; await expect(h.remove(handlerCtx(), a, {})).rejects.toThrow(); expect(rds.commandCalls(DeleteDBInstanceCommand)).toHaveLength(0); });
  it("S3 empties versions/delete markers and multipart uploads before deleting", async () => {
    const a = parseArn(bucketArn)!; const h = resolveHandler(a)!.handler; const log: string[] = [];
    s3.on(ListObjectVersionsCommand).resolvesOnce({ Versions: [{ Key: "v", VersionId: "1" }], DeleteMarkers: [{ Key: "v", VersionId: "2" }] }).resolves({});
    s3.on(DeleteObjectsCommand).callsFake((input) => { expect(input.Delete.Objects).toHaveLength(2); log.push("versions"); return {}; });
    s3.on(ListMultipartUploadsCommand).resolvesOnce({ Uploads: [{ Key: "part", UploadId: "up" }] }).resolves({}); s3.on(AbortMultipartUploadCommand).callsFake(() => { log.push("abort"); return {}; }); s3.on(DeleteBucketCommand).callsFake(() => { log.push("bucket"); return {}; });
    expect(await h.remove(handlerCtx(), a, liveRunTags(RUN))).toBe("deleted"); expect(log).toEqual(["versions", "abort", "bucket"]);
    const state = parseArn(`arn:aws:s3:::zenith-state-${ACCOUNT}-${REGION}`)!; await expect(h.remove(handlerCtx(), state, liveRunTags(RUN))).rejects.toThrow("state bucket"); expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });
  it("ages only valid ids and reports invalid tag values", async () => {
    const recent = "zlive-202610011100-ab12";
    tag.on(GetResourcesCommand).callsFake((input) => ({ ResourceTagMappingList: input.TagFilters?.[0]?.Values ? [] : [mapping(bucketArn), mapping("arn:aws:s3:::recent", recent), mapping("arn:aws:s3:::bad", "zlive-202613011200-ab12"), mapping("arn:aws:s3:::foreign", "production")] }));
    const r = await cleanupRuns({ ...base(), selector: { olderThanHours: 6 }, now: () => new Date("2026-10-01T12:00:00Z") }); expect(r.runs.map((r) => r.runId)).toEqual([RUN]); expect(r.ignoredTagValues).toEqual(["production", "zlive-202613011200-ab12"]);
  });
  it("second pass retries DependencyViolation and replaces the first failure", async () => {
    const a = arn("ec2", "subnet/subnet-1"); listing([a]); let attempts = 0;
    const handler: Handler = { id: "test", rank: 1, match: () => ({}), remove: async () => { if (++attempts === 1) throw Object.assign(new Error("in use"), { name: "DependencyViolation" }); return "deleted"; } };
    const r = await cleanupRuns({ ...base(), dryRun: false, handlers: [handler] }); expect(attempts).toBe(2); expect(r.summary.failed).toBe(0); expect(r.summary.deleted).toBe(1); expect(r.ok).toBe(true); expect(tag.commandCalls(GetResourcesCommand).filter((c) => c.args[0].input.ResourceARNList)).toHaveLength(2);
  });
  it("can disable tofu or inject destroy, and still sweeps after destroy throws", async () => {
    listing([]); const destroy = vi.fn(async () => { throw new Error("tofu died"); });
    const state = { ...newRunState({ runId: RUN, accountId: ACCOUNT, region: REGION }), environmentIds: ["env_test"], workspaceId: "ws_test", stateBucket: "zenith-state-test" };
    const adopt = vi.fn(async () => ({ adopted: [], skipped: [], alreadyTagged: 0 }));
    const r = await cleanupRuns({ ...base(), useTofu: true, dryRun: false, destroy, adopt, loadRunState: async () => state }); expect(destroy).toHaveBeenCalledOnce(); expect(r.runs[0]?.tofu[0]?.status).toBe("failed"); expect(r.ok).toBe(false); expect(tag.calls().length).toBeGreaterThan(0);
    await cleanupRuns({ ...base(), destroy, adopt, loadRunState: async () => state }); expect(destroy).toHaveBeenCalledOnce();
  });
  it("CLI reports usage/safety refusal as 2, success as 0, problems as 1", async () => {
    const io = { out: vi.fn(), err: vi.fn() }; expect(await runCleanupCli(["--run-id", RUN], {}, io)).toBe(2); expect(await runCleanupCli(["--help"], {}, io)).toBe(0);
    sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT }); ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "true" } });
    const env = { ZENITH_LIVE_AWS_ACCOUNT_ID: ACCOUNT, ZENITH_LIVE_REGION: REGION };
    listing([]); expect(await runCleanupCli(["--run-id", RUN, "--no-tofu", "--out", await temp()], env, io)).toBe(0);
    listing([arn("unknown", "unhandled")]); expect(await runCleanupCli(["--run-id", RUN, "--no-tofu", "--out", await temp()], env, io)).toBe(1);
  });
});
