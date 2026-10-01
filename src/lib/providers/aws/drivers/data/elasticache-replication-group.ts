/**
 * `aws:elasticache_replication_group` driver (Redis OSS 7.1, cluster mode
 * disabled).
 *
 * AUTHENTICATION DECISION (researched against hashicorp/aws 6.66.0's schema and
 * the ElastiCache documentation, recorded honestly):
 *
 *   The spec has no credential contract for Redis (Postgres has
 *   `credentials: "generated"`). The options were:
 *     1. `auth_token` on the replication group. The token would be a secret
 *        value in tofu state and plan, which this platform forbids.
 *     2. A password-type `aws_elasticache_user`. Same problem (`passwords`), and
 *        the write-only `passwords_wo`/`auth_token_wo` variants need an
 *        `ephemeral` block, which `TofuFragment` cannot express.
 *     3. RBAC with IAM authentication: an `aws_elasticache_user` whose
 *        `authentication_mode.type = "iam"`, in a user group attached to the
 *        replication group, plus transit encryption. NO secret exists anywhere:
 *        clients sign a short-lived token with their IAM role.   <- CHOSEN
 *
 *   Tradeoffs of the choice:
 *     + no credential in state, plan, env vars or Secrets Manager; access is
 *       governed by the workload role's `elasticache:Connect` grant (compiled by
 *       `aws:iam_role` from a `connect` grant on this node);
 *     + the `default` user is created DISABLED (`off`, no password), so the
 *       unauthenticated default access of a fresh group does not exist.
 *     - the client must implement IAM auth: it presents a SigV4-presigned token
 *       (valid 15 minutes) as the password and must re-authenticate before
 *       the 12-hour connection limit. A plain `REDIS_URL` with a static
 *       password will NOT work; libraries without a credential-provider hook
 *       need a small wrapper. This is a real integration cost, not a detail.
 *     - IAM auth needs Redis OSS / Valkey 7.0+ and TLS (both enforced here), so
 *       the engine version is pinned at 7.1 and is not configurable.
 *     - the user id must equal the user name (an ElastiCache rule for IAM users).
 *   Expansion does not yet derive a `connect` identity grant for `cache`
 *   bindings (it emits a firewall rule only); until it does, no workload role
 *   can call `elasticache:Connect` on this node. Listed as a contract request.
 *
 * Compiled resources: subnet group (private subnets; ≥ 2 when
 * `highAvailability`), the node's security group, two users (disabled default,
 * IAM app user), a user group, and the replication group: at-rest + in-transit
 * encryption (`required`), automatic failover + Multi-AZ with 2 clusters when
 * `highAvailability` else 1, snapshot retention from `backup`, a deterministic
 * final snapshot unless the policy allows deletion and there is no backup.
 *
 * Honest limits: ElastiCache has no deletion-protection flag, so
 * `deletionPolicy` is enforced by Zenith's plan policy and the final snapshot,
 * not by AWS; ElastiCache snapshots are daily, so `hourly` compiles to the same
 * 7-day daily retention as `daily`. Evidence is `contract` only.
 */
import { DescribeReplicationGroupsCommand, ElastiCacheClient, ListTagsForResourceCommand, type ReplicationGroup } from "@aws-sdk/client-elasticache";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import {
  addSecurityGroup,
  cloudName,
  DriverCompileError,
  FragmentBuilder,
  isArnOf,
  nodeName,
  paginate,
  parseArn,
  refExpr,
  REF,
  resourceTags,
  securityGroupExpr,
  subnetsOf,
  tfLabel,
} from "./_shared";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  BACKUPS,
  call,
  candidate,
  DELETION_POLICIES,
  EMPTY_FRAGMENT,
  escapeTemplate,
  expectedFor,
  findByTags,
  guardObserve,
  guardRuntime,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  safeTags,
  scalars,
  sizeOf,
  specBool,
  specEnum,
  tagMap,
  validId,
  verificationOf,
  type AwsDriverContext,
  type BackupPolicy,
  type DeletionPolicy,
  type ReadResult,
  type RuntimeRead,
  type Size,
} from "./support";

export const ELASTICACHE_SOURCE = "aws.elasticache_replication_group@1";
export const REDIS_ENGINE_VERSION = "7.1";
export const REDIS_PARAMETER_GROUP = "default.redis7";

export const CACHE_CLASS_BY_SIZE: Readonly<Record<Size, string>> = {
  nano: "cache.t4g.micro",
  small: "cache.t4g.small",
  standard: "cache.t4g.medium",
  performance: "cache.m6g.large",
};

const NODE_TYPE = /^cache\.[a-z0-9]{2,10}\.[a-z0-9]{3,12}$/;
const GROUP_ID = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;

/** Disabled default user: the documented shape for "no access"; it carries no password. */
export const DEFAULT_USER_ACCESS = "off +get ~keys*";
/** App user: every key and channel, every command except the `@dangerous` category (FLUSHALL, KEYS, CONFIG, …). */
export const APP_USER_ACCESS = "on ~* &* +@all -@dangerous";

export interface RedisSpecView {
  highAvailability: boolean;
  backup: BackupPolicy;
  deletionPolicy: DeletionPolicy;
  nodeType: string;
}

export function readRedisSpec(node: ResourceNode): RedisSpecView {
  const raw = node.spec as Record<string, unknown>;
  const override = typeof raw.instanceClass === "string" && raw.instanceClass !== "" ? raw.instanceClass : undefined;
  if (override !== undefined && !NODE_TYPE.test(override)) {
    throw new DriverCompileError("invalid_spec", node.address, `spec.instanceClass "${override.slice(0, 30)}" is not an ElastiCache node type such as cache.t4g.small.`);
  }
  const size = sizeOf(node);
  if (override === undefined && size === undefined) {
    throw new DriverCompileError("invalid_spec", node.address, "spec.size must be one of nano, small, standard, performance (or set spec.instanceClass).");
  }
  return {
    highAvailability: specBool(node, "highAvailability", false),
    backup: specEnum(node, "backup", BACKUPS),
    deletionPolicy: specEnum(node, "deletionPolicy", DELETION_POLICIES),
    nodeType: override ?? CACHE_CLASS_BY_SIZE[size as Size],
  };
}

/** Daily snapshots only: `daily` and `hourly` are both 7 days, `none` disables them. */
export const snapshotRetentionFor = (backup: BackupPolicy): number => (backup === "none" ? 0 : 7);

/** ≤ 32 characters so `<base>-default` fits ElastiCache's 40-character user id limit. */
export function cacheBaseNameFor(ctx: Pick<CompileContext, "namePrefix">, address: string): string {
  const base = cloudName(ctx.namePrefix, nodeName(address), 32);
  return /^[a-z]/.test(base) ? base : `z${base}`.slice(0, 32);
}

export function compileElasticacheGroup(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const spec = readRedisSpec(node);
  const label = tfLabel(node.address);
  const base = cacheBaseNameFor(ctx, node.address);
  const subnets = subnetsOf(node, ctx, "private");
  if (subnets.length < (spec.highAvailability ? 2 : 1)) {
    throw new DriverCompileError(
      "missing_node",
      node.address,
      spec.highAvailability
        ? `highAvailability needs private subnets in at least 2 availability zones, but this node depends on ${subnets.length}.`
        : "a cache subnet group needs at least one private subnet, but this node depends on none."
    );
  }

  const tags = safeTags(resourceTags(ctx.tags, node.address, base));
  const finalSnapshot = spec.deletionPolicy !== "allow" || spec.backup !== "none";
  const b = new FragmentBuilder(node.address);

  b.resource("aws_elasticache_replication_group", label, {
    replication_group_id: base,
    description: escapeTemplate(`Zenith managed Redis for ${node.address}`),
    engine: "redis",
    engine_version: REDIS_ENGINE_VERSION,
    parameter_group_name: REDIS_PARAMETER_GROUP,
    node_type: spec.nodeType,
    port: 6379,

    num_cache_clusters: spec.highAvailability ? 2 : 1,
    automatic_failover_enabled: spec.highAvailability,
    multi_az_enabled: spec.highAvailability,

    at_rest_encryption_enabled: true,
    transit_encryption_enabled: true,
    transit_encryption_mode: "required",
    user_group_ids: [`\${aws_elasticache_user_group.${label}_users.user_group_id}`],

    subnet_group_name: `\${aws_elasticache_subnet_group.${label}_subnets.name}`,
    security_group_ids: [securityGroupExpr(ctx, node.address)],

    snapshot_retention_limit: snapshotRetentionFor(spec.backup),
    ...(finalSnapshot ? { final_snapshot_identifier: `${base}-final` } : {}),
    auto_minor_version_upgrade: true,
    tags,
  });

  b.resource("aws_elasticache_subnet_group", `${label}_subnets`, {
    name: base,
    description: escapeTemplate(`Zenith managed subnet group for ${node.address}`),
    subnet_ids: subnets.map((s) => refExpr(ctx.ref(s.address, REF.id))),
    tags,
  });

  // The group's built-in unauthenticated `default` user is replaced by a disabled one.
  b.resource("aws_elasticache_user", `${label}_default`, {
    user_id: `${base}-default`,
    user_name: "default",
    engine: "redis",
    access_string: DEFAULT_USER_ACCESS,
    authentication_mode: { type: "no-password-required" },
    tags,
  });
  // IAM-authenticated application user: user id == user name is an ElastiCache rule for IAM users.
  b.resource("aws_elasticache_user", `${label}_app`, {
    user_id: `${base}-app`,
    user_name: `${base}-app`,
    engine: "redis",
    access_string: APP_USER_ACCESS,
    authentication_mode: { type: "iam" },
    tags,
  });
  b.resource("aws_elasticache_user_group", `${label}_users`, {
    user_group_id: `${base}-ug`,
    engine: "redis",
    user_ids: [`\${aws_elasticache_user.${label}_default.user_id}`, `\${aws_elasticache_user.${label}_app.user_id}`],
    tags,
  });

  addSecurityGroup(b, node, ctx);

  b.expose(REF.arn, `aws_elasticache_replication_group.${label}.arn`);
  b.expose(REF.id, `aws_elasticache_replication_group.${label}.replication_group_id`);
  b.expose("primary_endpoint_address", `aws_elasticache_replication_group.${label}.primary_endpoint_address`);
  // The IAM user's ARN, for `elasticache:Connect` grants (the group ARN is `arn`).
  b.expose("iam_user_arn", `aws_elasticache_user.${label}_app.arn`);

  b.output(`${label}_arn`, `\${aws_elasticache_replication_group.${label}.arn}`);
  b.output(`${label}_primary_endpoint_address`, `\${aws_elasticache_replication_group.${label}.primary_endpoint_address}`, { description: "Connection host; clients authenticate with IAM, there is no password." });
  b.output(`${label}_iam_user_id`, `\${aws_elasticache_user.${label}_app.user_id}`, { description: "The ElastiCache user clients authenticate as with an IAM-signed token." });
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["nodeType", "automaticFailover", "multiAz", "atRestEncryption", "transitEncryption", "snapshotRetentionLimit", "memberClusterCount", "authTokenEnabled", "userGroupAttached"] as const;
const INFORMATIONAL_NAMES = ["status", "engineVersion", "primaryEndpointAddress", "primaryEndpointPort", "readerEndpointAddress", "clusterEnabled"] as const;
export const ELASTICACHE_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedElasticacheAttributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => buildExpectedElasticache(node));
}

function buildExpectedElasticache(node: ResourceNode): Record<string, unknown> {
  const spec = readRedisSpec(node);
  return {
    nodeType: spec.nodeType,
    automaticFailover: spec.highAvailability,
    multiAz: spec.highAvailability,
    atRestEncryption: true,
    transitEncryption: true,
    snapshotRetentionLimit: snapshotRetentionFor(spec.backup),
    memberClusterCount: spec.highAvailability ? 2 : 1,
    authTokenEnabled: false,
    userGroupAttached: true,
  };
}

/** `arn:…:replicationgroup:<id>` or a bare id → the replication group id. */
export function replicationGroupIdOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "elasticache", "replicationgroup")) return undefined;
    return validId(parseArn(externalId)?.resource.slice("replicationgroup:".length), GROUP_ID);
  }
  return validId(externalId, GROUP_ID);
}

const enabled = (s: string | undefined): boolean | undefined => (s === undefined ? undefined : s === "enabled" || s === "enabling");

async function describeGroup(ctx: AwsDriverContext, id: string): Promise<ReplicationGroup | undefined> {
  const ec = ctx.session.client(ElastiCacheClient);
  const out = await call(ctx, (o) => ec.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }), o));
  return out.ReplicationGroups?.[0];
}

type Resolved = ReplicationGroup | "missing" | { ambiguous: string };

async function resolveGroup(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<Resolved> {
  const id = replicationGroupIdOf(externalId);
  if (externalId !== undefined && externalId !== "" && id === undefined) return { ambiguous: "externalId is not a replication group ARN or id" };
  if (id !== undefined) return (await describeGroup(ctx, id)) ?? "missing";
  const { matches } = await findByTags(ctx, node, "elasticache:replicationgroup");
  const ids = matches.flatMap((m) => (isArnOf(m.arn, "elasticache", "replicationgroup") ? [m.arn] : []));
  if (ids.length === 0) return "missing";
  if (ids.length > 1) return { ambiguous: `${ids.length} replication groups carry the Zenith tags for ${node.address}; refusing to choose one` };
  const foundId = replicationGroupIdOf(ids[0]);
  if (foundId === undefined) return { ambiguous: "the tagged object's ARN is not a replication group ARN" };
  return (await describeGroup(ctx, foundId)) ?? "missing";
}

async function readTags(ctx: AwsDriverContext, arn: string): Promise<{ tags?: Record<string, string>; failure?: string }> {
  try {
    const ec = ctx.session.client(ElastiCacheClient);
    const out = await call(ctx, (o) => ec.send(new ListTagsForResourceCommand({ ResourceName: arn }), o));
    return { tags: tagMap(out.TagList) };
  } catch (err) {
    const f = classifyAwsError(err, ctx.signal);
    if (f.kind === "aborted") throw err;
    return { failure: f.code };
  }
}

function primaryMember(g: ReplicationGroup): string | undefined {
  const members = g.NodeGroups?.flatMap((n) => n.NodeGroupMembers ?? []) ?? [];
  return (members.find((m) => m.CurrentRole === "primary") ?? members[0])?.CacheClusterId;
}

async function observeGroup(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    ELASTICACHE_SOURCE,
    ELASTICACHE_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const g = await resolveGroup(ctx, node, externalId);
      if (g === "missing") return { kind: "missing" };
      if ("ambiguous" in g) return { kind: "ambiguous", detail: g.ambiguous };
      const a = new Attributes(ctx);
      a.set("nodeType", g.CacheNodeType);
      a.set("automaticFailover", enabled(g.AutomaticFailover));
      a.set("multiAz", enabled(g.MultiAZ));
      a.set("atRestEncryption", g.AtRestEncryptionEnabled);
      a.set("transitEncryption", g.TransitEncryptionEnabled);
      a.set("snapshotRetentionLimit", g.SnapshotRetentionLimit);
      a.set("memberClusterCount", g.MemberClusters?.length);
      a.set("authTokenEnabled", g.AuthTokenEnabled);
      a.set("userGroupAttached", (g.UserGroupIds?.length ?? 0) > 0);
      a.set("status", g.Status);
      a.set("primaryEndpointAddress", g.NodeGroups?.[0]?.PrimaryEndpoint?.Address ?? g.ConfigurationEndpoint?.Address);
      a.set("primaryEndpointPort", g.NodeGroups?.[0]?.PrimaryEndpoint?.Port ?? g.ConfigurationEndpoint?.Port);
      a.set("readerEndpointAddress", g.NodeGroups?.[0]?.ReaderEndpoint?.Address);
      a.set("clusterEnabled", g.ClusterEnabled);
      // DescribeReplicationGroups does not return the engine version; reading it needs DescribeCacheClusters.
      a.unknown("engineVersion", "not_inspected", "the replication group response does not carry the engine version");
      const tags = g.ARN ? await readTags(ctx, g.ARN) : {};
      return {
        kind: "present",
        externalId: g.ARN ?? g.ReplicationGroupId ?? "",
        attributes: a.finish(ELASTICACHE_ATTRIBUTE_NAMES),
        native: {
          replicationGroupId: g.ReplicationGroupId,
          memberClusters: g.MemberClusters ?? [],
          cacheClusterId: primaryMember(g),
          userGroupIds: g.UserGroupIds ?? [],
          ...(tags.tags ? { tags: tags.tags } : { tagsUnreadable: tags.failure ?? "no_arn" }),
          pendingModifiedValues: Object.fromEntries(Object.entries(g.PendingModifiedValues ?? {}).filter(([, v]) => v !== undefined && v !== null)),
        },
      };
    },
    ["tags", "replicationGroupId", "memberClusters", "cacheClusterId"]
  );
}

/* --------------------------------- runtime --------------------------------- */

export function elasticacheHealthOf(status: string | undefined): HealthState {
  if (status === undefined) return "unknown";
  if (status === "available") return "healthy";
  if (["creating", "modifying", "snapshotting"].includes(status)) return "degraded";
  if (["create-failed", "deleting", "deleted"].includes(status)) return "unhealthy";
  return "unknown";
}

async function runtimeGroup(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  return guardRuntime(ctx, node, ELASTICACHE_SOURCE, async (): Promise<RuntimeRead> => {
    const g = await resolveGroup(ctx, node, externalId);
    if (g === "missing") return "missing";
    if ("ambiguous" in g) return { health: "unknown", counts: {}, signals: ["ambiguous_match"] };
    const members = g.NodeGroups?.flatMap((n) => n.NodeGroupMembers ?? []) ?? [];
    const pending = Object.entries(g.PendingModifiedValues ?? {}).filter(([, v]) => v !== undefined && v !== null);
    const signals = [`status:${g.Status ?? "unknown"}`, ...pending.map(([k]) => `pending_modification:${k}`).sort()];
    if (members.length > 1 && enabled(g.AutomaticFailover) === false) signals.push("failover_disabled_with_replicas");
    if (members.length > 0 && !members.some((m) => m.CurrentRole === "primary")) signals.push("no_primary");
    return {
      health: signals.includes("no_primary") && g.Status === "available" ? "degraded" : elasticacheHealthOf(g.Status),
      counts: { memberClusters: g.MemberClusters?.length ?? 0, nodes: members.length, replicas: members.filter((m) => m.CurrentRole === "replica").length, pendingModifications: pending.length },
      signals,
    };
  });
}

/* -------------------------------- discover --------------------------------- */

async function discoverGroups(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const ec = ctx.session.client(ElastiCacheClient);
  const { items } = await paginate(
    async (marker) => {
      const out = await call(ctx, (o) => ec.send(new DescribeReplicationGroupsCommand({ MaxRecords: 100, ...(marker ? { Marker: marker } : {}) }), o));
      return { items: out.ReplicationGroups ?? [], next: out.Marker || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const g of items) {
    if (!g.ReplicationGroupId) continue;
    const tags = g.ARN && reads < MAX_TAG_READS ? (reads++, (await readTags(ctx, g.ARN)).tags) : undefined;
    found.push(
      candidate(ctx, {
        kind: "redis",
        nativeType: "aws:elasticache_replication_group",
        externalId: g.ARN ?? g.ReplicationGroupId,
        name: g.ReplicationGroupId,
        ...(tags ? { tags } : {}),
        attributes: scalars({
          status: g.Status,
          nodeType: g.CacheNodeType,
          memberClusters: g.MemberClusters?.length,
          automaticFailover: enabled(g.AutomaticFailover),
          atRestEncryption: g.AtRestEncryptionEnabled,
          transitEncryption: g.TransitEncryptionEnabled,
          clusterEnabled: g.ClusterEnabled,
          tagsRead: tags !== undefined,
        }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

/* --------------------------------- driver ---------------------------------- */

export const elasticacheReplicationGroupDriver: ResourceDriver<AwsSession> = {
  id: ELASTICACHE_SOURCE,
  provider: "aws",
  kind: "redis",
  nativeType: "aws:elasticache_replication_group",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileElasticacheGroup,
  observe: observeGroup,
  runtime: runtimeGroup,
  expectedAttributes: expectedElasticacheAttributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "available", "the replication group is available", "status", (v) => v === "available"),
      attrCheck(observation, "at_rest_encrypted", "data is encrypted at rest", "atRestEncryption", (v) => v === true),
      attrCheck(observation, "transit_encrypted", "connections require TLS", "transitEncryption", (v) => v === true),
      attrCheck(observation, "iam_user_group", "an RBAC user group (IAM authentication) is attached", "userGroupAttached", (v) => v === true),
      matchesExpectedCheck(expectedElasticacheAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverGroups,
};
