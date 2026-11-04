import { DescribeReplicationGroupsCommand, ElastiCacheClient, ListTagsForResourceCommand, type ReplicationGroup } from "@aws-sdk/client-elasticache";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { elasticacheReplicationGroupDriver as driver } from "@/lib/providers/aws/drivers/data";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { APP_USER_ACCESS, DEFAULT_USER_ACCESS, snapshotRetentionFor } from "@/lib/providers/aws/drivers/data/elasticache-replication-group";
import { driftOf } from "./_drift";
import { awsError, compileCtx, driverCtx, mkNode, networkNodes, redisSpec, tagRecord } from "./_helpers";

const ec = mockClient(ElastiCacheClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  ec.reset();
  tagging.reset();
});
afterAll(() => {
  ec.restore();
  tagging.restore();
});

const SUBNETS = ["subnet/private-a", "subnet/private-b"];
const node = mkNode("redis/cache", "redis", redisSpec({ highAvailability: true }), { dependsOn: SUBNETS });
const build = (spec: Record<string, unknown>, over: Partial<typeof node> = {}) => mkNode("redis/cache", "redis", redisSpec(spec), { dependsOn: SUBNETS, ...over });
const compile = (n = node) => driver.compile!(n, compileCtx([...networkNodes(), n]));
type Body = Record<string, unknown>;
const group = (f: ReturnType<typeof compile>): Body => (f.resource!.aws_elasticache_replication_group as Record<string, Body>).redis_cache;
const users = (f: ReturnType<typeof compile>) => f.resource!.aws_elasticache_user as Record<string, Body>;

describe("aws:elasticache_replication_group compile", () => {
  it("defines the group first, then subnet group, two users, a user group and the node's security group", () => {
    expect(compile().addresses).toEqual([
      "aws_elasticache_replication_group.redis_cache",
      "aws_elasticache_subnet_group.redis_cache_subnets",
      "aws_elasticache_user.redis_cache_default",
      "aws_elasticache_user.redis_cache_app",
      "aws_elasticache_user_group.redis_cache_users",
      "aws_security_group.redis_cache_sg",
    ]);
  });

  it("encrypts at rest and in transit, requires TLS and attaches the IAM user group", () => {
    expect(group(compile())).toMatchObject({
      engine: "redis",
      engine_version: "7.1",
      at_rest_encryption_enabled: true,
      transit_encryption_enabled: true,
      transit_encryption_mode: "required",
      user_group_ids: ["${aws_elasticache_user_group.redis_cache_users.user_group_id}"],
      security_group_ids: ["${local.ref_redis_cache__security_group_id}"],
      subnet_group_name: "${aws_elasticache_subnet_group.redis_cache_subnets.name}",
    });
  });

  it("uses IAM authentication: no password, no auth token, a disabled default user", () => {
    const f = compile();
    const text = JSON.stringify(f);
    expect(users(f).redis_cache_app).toMatchObject({ user_name: "zen-prod-cache-app", user_id: "zen-prod-cache-app", access_string: APP_USER_ACCESS, authentication_mode: { type: "iam" } });
    expect(users(f).redis_cache_default).toMatchObject({ user_name: "default", access_string: DEFAULT_USER_ACCESS, authentication_mode: { type: "no-password-required" } });
    expect(DEFAULT_USER_ACCESS.startsWith("off ")).toBe(true);
    expect(APP_USER_ACCESS).toContain("-@dangerous");
    for (const forbidden of ["auth_token", "passwords", "password_wo", "no_password_required", "random_password"]) expect(text).not.toContain(forbidden);
  });

  it.each([
    [true, 2],
    [false, 1],
  ])("highAvailability %s → %i cache clusters with failover and Multi-AZ to match", (ha, clusters) => {
    expect(group(compile(build({ highAvailability: ha })))).toMatchObject({ num_cache_clusters: clusters, automatic_failover_enabled: ha, multi_az_enabled: ha });
  });

  it.each([
    ["none", "allow", 0, false],
    ["none", "approval", 0, true],
    ["daily", "allow", 7, true],
    ["daily", "deny", 7, true],
    ["hourly", "approval", 7, true],
  ] as const)("backup %s / deletionPolicy %s → retention %i, final snapshot %s", (backup, policy, days, finalSnap) => {
    const g = group(compile(build({ backup, deletionPolicy: policy })));
    expect(g.snapshot_retention_limit).toBe(days);
    expect(snapshotRetentionFor(backup)).toBe(days);
    expect(g.final_snapshot_identifier !== undefined).toBe(finalSnap);
    if (finalSnap) expect(g.final_snapshot_identifier).toBe("zen-prod-cache-final");
  });

  it.each([
    ["nano", "cache.t4g.micro"],
    ["small", "cache.t4g.small"],
    ["standard", "cache.t4g.medium"],
    ["performance", "cache.m6g.large"],
  ] as const)("size %s → %s; an explicit node type wins", (size, klass) => {
    expect(group(compile(build({ size }))).node_type).toBe(klass);
    expect(group(compile(build({ size, instanceClass: "cache.r7g.large" }))).node_type).toBe("cache.r7g.large");
  });

  it("publishes arn, id, endpoint and the IAM user ARN; outputs carry no secret", () => {
    const f = compile();
    expect(Object.keys(f.locals!).sort()).toEqual(
      ["ref_redis_cache__arn", "ref_redis_cache__iam_user_arn", "ref_redis_cache__id", "ref_redis_cache__primary_endpoint_address", "ref_redis_cache__security_group_id"].sort()
    );
    expect(f.locals!.ref_redis_cache__iam_user_arn).toBe("${aws_elasticache_user.redis_cache_app.arn}");
    expect(Object.values(f.output!).every((o) => o.sensitive !== true)).toBe(true);
  });

  it("is deterministic and compiles non-managed nodes to nothing", () => {
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    expect(compile(build({}, { ownership: "referenced" }))).toEqual({ addresses: [] });
  });

  it("refuses HA without two zones, and malformed or unknown inputs", () => {
    const one = build({ highAvailability: true }, { dependsOn: ["subnet/private-a"] });
    expect(() => driver.compile!(one, compileCtx([...networkNodes(), one]))).toThrow(/at least 2 availability zones/);
    // a single-node cache may live in one subnet
    const single = build({ highAvailability: false }, { dependsOn: ["subnet/private-a"] });
    expect(() => driver.compile!(single, compileCtx([...networkNodes(), single]))).not.toThrow();
    for (const over of [{ deletionPolicy: "x" }, { backup: "x" }, { size: "huge" }, { instanceClass: "m6g.large" }]) {
      const bad = build(over);
      expect(() => driver.compile!(bad, compileCtx([...networkNodes(), bad]))).toThrow(DriverCompileError);
    }
  });
});

const ARN = "arn:aws:elasticache:ap-south-1:123456789012:replicationgroup:zen-prod-cache";
const rg = (over: Partial<ReplicationGroup> = {}): ReplicationGroup => ({
  ReplicationGroupId: "zen-prod-cache",
  ARN,
  Status: "available",
  CacheNodeType: "cache.t4g.small",
  AutomaticFailover: "enabled",
  MultiAZ: "enabled",
  AtRestEncryptionEnabled: true,
  TransitEncryptionEnabled: true,
  AuthTokenEnabled: false,
  SnapshotRetentionLimit: 7,
  ClusterEnabled: false,
  MemberClusters: ["zen-prod-cache-001", "zen-prod-cache-002"],
  UserGroupIds: ["zen-prod-cache-ug"],
  NodeGroups: [
    {
      NodeGroupId: "0001",
      PrimaryEndpoint: { Address: "master.zen-prod-cache.abc.aps1.cache.amazonaws.com", Port: 6379 },
      ReaderEndpoint: { Address: "replica.zen-prod-cache.abc.aps1.cache.amazonaws.com", Port: 6379 },
      NodeGroupMembers: [
        { CacheClusterId: "zen-prod-cache-001", CurrentRole: "primary" },
        { CacheClusterId: "zen-prod-cache-002", CurrentRole: "replica" },
      ],
    },
  ],
  PendingModifiedValues: {},
  ...over,
});
const tagsOf = (address = "redis/cache") => Object.entries(tagRecord(address)).map(([Key, Value]) => ({ Key, Value }));

describe("aws:elasticache_replication_group observe / runtime / verify", () => {
  it("reads configuration by ARN, matches the spec, and carries the identifiers observability needs", async () => {
    ec.on(DescribeReplicationGroupsCommand, { ReplicationGroupId: "zen-prod-cache" }).resolves({ ReplicationGroups: [rg()] });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: tagsOf() });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.elasticache_replication_group@1" });
    expect(obs.native).toMatchObject({ replicationGroupId: "zen-prod-cache", memberClusters: ["zen-prod-cache-001", "zen-prod-cache-002"], cacheClusterId: "zen-prod-cache-001" });
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:managed"]).toBe("true");
    expect(obs.attributes.primaryEndpointAddress).toMatchObject({ state: "known", value: "master.zen-prod-cache.abc.aps1.cache.amazonaws.com" });
    // the response carries no engine version, so it is honestly unknown
    expect(obs.attributes.engineVersion).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
  });

  it("reports drift in the units it observes (auth token enabled, encryption off, wrong size)", async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({
      ReplicationGroups: [rg({ AuthTokenEnabled: true, TransitEncryptionEnabled: false, CacheNodeType: "cache.m6g.large", UserGroupIds: [] })],
    });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: tagsOf() });
    const obs = await driver.observe!(driverCtx(), node, ARN);
    const f = driftOf(node, obs, driver.expectedAttributes!);
    expect(f[0].fields!.map((x) => x.attribute).sort()).toEqual(["authTokenEnabled", "nodeType", "transitEncryption", "userGroupAttached"]);
  });

  it("finds the group by Zenith tags through the tagging API when no id is known, and refuses ambiguity", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN, Tags: tagsOf() }] });
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [rg()] });
    ec.on(ListTagsForResourceCommand).resolves({ TagList: tagsOf() });
    const found = await driver.observe!(driverCtx(), node);
    expect(found.presence).toBe("present");
    const filters = tagging.commandCalls(GetResourcesCommand)[0].args[0].input;
    expect(filters.TagFilters).toEqual(
      expect.arrayContaining([
        { Key: "zenith:environment", Values: ["env_test"] },
        { Key: "zenith:resource", Values: ["redis/cache"] },
        { Key: "zenith:workspace", Values: ["ws_test"] },
      ])
    );

    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }, { ResourceARN: `${ARN}-2` }] });
    const twin = await driver.observe!(driverCtx(), node);
    expect(twin.presence).toBe("unknown");
    expect(twin.error).toMatch(/refusing to choose/);

    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("missing");
  });

  it("keeps the observation when only the tag read is denied (tags unreadable, not invented)", async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [rg()] });
    ec.on(ListTagsForResourceCommand).rejects(awsError("AccessDenied", "no", 403));
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs.presence).toBe("present");
    expect(obs.native).toMatchObject({ tagsUnreadable: "AccessDenied" });
    expect(obs.native).not.toHaveProperty("tags");
  });

  it("classifies NotFound, AccessDenied and throttling", async () => {
    ec.on(DescribeReplicationGroupsCommand).rejects(awsError("ReplicationGroupNotFoundFault", "nope", 404));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("missing");
    ec.on(DescribeReplicationGroupsCommand).rejects(awsError("AccessDenied", "no", 403));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("inaccessible");
    ec.on(DescribeReplicationGroupsCommand).rejects(awsError("Throttling", "slow", 400));
    const t = await driver.observe!(driverCtx(), node, ARN);
    expect(t.presence).toBe("unknown");
    expect(t.attributes.status).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("runtime: status to health, member counts and failover signals", async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [rg()] });
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "healthy", counts: { memberClusters: 2, nodes: 2, replicas: 1, pendingModifications: 0 }, signals: ["status:available"] });

    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [rg({ Status: "modifying", AutomaticFailover: "disabled", PendingModifiedValues: { AutomaticFailoverStatus: "enabled" } })] });
    const rt = await driver.runtime!(driverCtx(), node, ARN);
    expect(rt.health).toBe("degraded");
    expect(rt.signals).toEqual(["status:modifying", "pending_modification:AutomaticFailoverStatus", "failover_disabled_with_replicas"]);

    ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [rg({ NodeGroups: [{ NodeGroupMembers: [{ CacheClusterId: "a", CurrentRole: "replica" }] }] })] });
    expect((await driver.runtime!(driverCtx(), node, ARN)).signals).toContain("no_primary");

    ec.on(DescribeReplicationGroupsCommand).rejects(awsError("ReplicationGroupNotFoundFault", "gone", 404));
    expect(await driver.runtime!(driverCtx(), node, ARN)).toMatchObject({ health: "unhealthy", signals: ["missing"] });
  });

  it("verify: passes when encrypted with an IAM user group, fails on plaintext transit", async () => {
    const check = async (g: ReplicationGroup) => {
      ec.on(DescribeReplicationGroupsCommand).resolves({ ReplicationGroups: [g] });
      ec.on(ListTagsForResourceCommand).resolves({ TagList: tagsOf() });
      const ctx = driverCtx();
      return driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    };
    expect((await check(rg())).status).toBe("passed");
    const bad = await check(rg({ TransitEncryptionEnabled: false }));
    expect(bad.status).toBe("failed");
    expect(bad.checks.find((c) => c.id === "transit_encrypted")!.passed).toBe(false);
    expect((await check(rg({ UserGroupIds: [] }))).checks.find((c) => c.id === "iam_user_group")!.passed).toBe(false);
  });

  it("discover: lists replication groups, marks the Zenith-tagged one, reads tags within a bound", async () => {
    ec.on(DescribeReplicationGroupsCommand).resolves({
      ReplicationGroups: [rg(), rg({ ReplicationGroupId: "foreign", ARN: ARN.replace("zen-prod-cache", "foreign") })],
    });
    ec.on(ListTagsForResourceCommand, { ResourceName: ARN }).resolves({ TagList: tagsOf() });
    ec.on(ListTagsForResourceCommand, { ResourceName: ARN.replace("zen-prod-cache", "foreign") }).resolves({ TagList: [] });
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.kind, f.zenithTagged])).toEqual([
      ["foreign", "redis", false],
      ["zen-prod-cache", "redis", true],
    ]);
  });
});
