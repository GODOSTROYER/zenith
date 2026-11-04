/**
 * Native deleters for the resource types a live run creates outside (or
 * alongside) OpenTofu: the catch-all behind `tofu destroy`.
 *
 * Each handler deletes ONE resource and waits for it to be gone. The cleaner
 * (`cleanup.ts`) decides WHETHER it may: it lists by tag, re-reads the resource's
 * tags immediately before calling a handler and refuses anything that does not
 * carry this run's `zenith:live-run` tag. Handlers add two defences of their
 * own:
 *
 *   - handlers that destroy data (RDS, ElastiCache, S3, SQS, secrets, ECR)
 *     re-assert the run tag on the tags they were handed before the first
 *     destructive call, so a mistake in the cleaner cannot reach them;
 *   - handlers for resources with a name we control refuse a name that does not
 *     contain the run's id (or one of its environment ids): the bootstrap state
 *     bucket, Zenith's own roles and anything else outside `zenith-<run>-…`.
 *
 * Order (rank): ECS services, listeners, load balancers, target groups, RDS,
 * ElastiCache, ECS clusters and task definitions, the storage and plumbing
 * types, IAM roles, then the network (NAT, endpoints, addresses, gateways,
 * route tables, subnets, security groups, VPCs) in `cleanup-handlers-ec2.ts`.
 *
 * RDS instances are deleted WITHOUT a final snapshot. That is correct only
 * because the run tag was just verified: a live run's databases are disposable
 * by definition (it is the whole point of the sandbox marker).
 *
 * Verified only against `aws-sdk-client-mock` and the AWS API documentation;
 * none of these calls has been made against a real account.
 */
import { DescribeServicesCommand, DeleteClusterCommand, DeleteServiceCommand, DeregisterTaskDefinitionCommand, ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { DeleteListenerCommand, DeleteLoadBalancerCommand, DeleteTargetGroupCommand, DescribeLoadBalancersCommand, ElasticLoadBalancingV2Client, ModifyLoadBalancerAttributesCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DeleteDBClusterCommand, DeleteDBInstanceCommand, DeleteDBParameterGroupCommand, DeleteDBSnapshotCommand, DeleteDBSubnetGroupCommand, DescribeDBClustersCommand, DescribeDBInstancesCommand, ModifyDBClusterCommand, ModifyDBInstanceCommand, RDSClient } from "@aws-sdk/client-rds";
import { DeleteCacheClusterCommand, DeleteCacheSubnetGroupCommand, DeleteReplicationGroupCommand, DescribeCacheClustersCommand, DescribeReplicationGroupsCommand, ElastiCacheClient } from "@aws-sdk/client-elasticache";
import { AbortMultipartUploadCommand, DeleteBucketCommand, DeleteObjectsCommand, ListMultipartUploadsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteQueueCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import { CloudWatchLogsClient, DeleteLogGroupCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DeleteRepositoryCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DeleteSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ACMClient, DeleteCertificateCommand } from "@aws-sdk/client-acm";
import { CloudWatchClient, DeleteAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { DeleteFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteRoleCommand, DeleteRolePolicyCommand, DetachRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListInstanceProfilesForRoleCommand, ListRolePoliciesCommand, RemoveRoleFromInstanceProfileCommand } from "@aws-sdk/client-iam";
import { assertRunTagged } from "./safety";
import { EC2_HANDLERS } from "./cleanup-handlers-ec2";
import { hasCode, isNotFound, lastSegment, pollUntil, regionOf, retryInUse, type Arn, type DeleteResult, type Handler, type HandlerCtx } from "./cleanup-util";

const STATE_BUCKET_PREFIX = "zenith-state-";

const svc = (arn: Arn, service: string, prefix: string): string | null => (arn.service === service && arn.resource.startsWith(prefix) ? arn.resource.slice(prefix.length) : null);

/** Run-tag defence in depth for handlers that destroy data. */
function requireVerified(ctx: HandlerCtx, arn: Arn, tags: Readonly<Record<string, string>>): void {
  assertRunTagged({ ...tags }, ctx.runId, arn.raw);
}

/* ---------------------------------- ECS ---------------------------------- */

function ecsServiceParts(resource: string): { cluster: string; name: string } {
  const parts = resource.split("/"); // service/<cluster>/<name> or service/<name>
  return parts.length >= 3 ? { cluster: parts[1]!, name: parts[2]! } : { cluster: "default", name: parts[1]! };
}

const ecsService: Handler = {
  id: "ecs:service",
  rank: 10,
  match: (a) => (svc(a, "ecs", "service/") === null ? null : { name: ecsServiceParts(a.resource).name }),
  async remove(ctx, arn) {
    const ecs = ctx.access.client(ECSClient, { region: regionOf(arn, ctx) });
    const { cluster, name } = ecsServiceParts(arn.resource);
    const describe = async () => (await ecs.send(new DescribeServicesCommand({ cluster, services: [name] }))).services?.[0];
    const current = await describe().catch((e) => (isNotFound(e) ? undefined : Promise.reject(e)));
    if (!current || current.status === "INACTIVE") return "already_gone";
    if (current.status !== "DRAINING") {
      await ecs.send(new UpdateServiceCommand({ cluster, service: name, desiredCount: 0 }));
      await ecs.send(new DeleteServiceCommand({ cluster, service: name, force: true }));
    }
    await pollUntil(ctx, `ECS service ${name}`, async () => {
      const s = await describe().catch((e) => (isNotFound(e) ? undefined : Promise.reject(e)));
      return !s || s.status === "INACTIVE";
    });
    return "deleted";
  },
};

const ecsCluster: Handler = {
  id: "ecs:cluster",
  rank: 60,
  match: (a) => {
    const name = svc(a, "ecs", "cluster/");
    return name === null ? null : { name };
  },
  async remove(ctx, arn) {
    const ecs = ctx.access.client(ECSClient, { region: regionOf(arn, ctx) });
    const name = lastSegment(arn.resource);
    return retryInUse(ctx, `ECS cluster ${name}`, async () => void (await ecs.send(new DeleteClusterCommand({ cluster: name }))));
  },
};

const ecsTaskDefinition: Handler = {
  id: "ecs:task-definition",
  rank: 61,
  match: (a) => {
    const name = svc(a, "ecs", "task-definition/");
    return name === null ? null : { name: name.split(":")[0] };
  },
  async remove(ctx, arn) {
    const ecs = ctx.access.client(ECSClient, { region: regionOf(arn, ctx) });
    try {
      await ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn.raw }));
      return "deleted"; // an inactive task definition costs nothing and has no further delete that matters
    } catch (e) {
      if (isNotFound(e) || hasCode(e, "ClientException")) return "already_gone";
      throw e;
    }
  },
};

/* ---------------------------- load balancing ------------------------------ */

const lbName = (resource: string): string => resource.split("/")[2] ?? "";

const elbListener: Handler = {
  id: "elbv2:listener",
  rank: 15,
  match: (a) => (a.service === "elasticloadbalancing" && a.resource.startsWith("listener/") ? { name: a.resource.split("/")[2] } : null),
  async remove(ctx, arn) {
    const elb = ctx.access.client(ElasticLoadBalancingV2Client, { region: regionOf(arn, ctx) });
    try {
      await elb.send(new DeleteListenerCommand({ ListenerArn: arn.raw }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const elbListenerRule: Handler = {
  id: "elbv2:listener-rule",
  rank: 16,
  match: (a) => (a.service === "elasticloadbalancing" && a.resource.startsWith("listener-rule/") ? { name: a.resource.split("/")[2] } : null),
  // Rules go with their listener; nothing to call.
  remove: async () => "covered_by_parent",
};

const loadBalancer: Handler = {
  id: "elbv2:loadbalancer",
  rank: 20,
  match: (a) => (a.service === "elasticloadbalancing" && a.resource.startsWith("loadbalancer/") ? { name: lbName(a.resource) } : null),
  async remove(ctx, arn) {
    const elb = ctx.access.client(ElasticLoadBalancingV2Client, { region: regionOf(arn, ctx) });
    const exists = async () => {
      try {
        return ((await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn.raw] }))).LoadBalancers?.length ?? 0) > 0;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    };
    if (!(await exists())) return "already_gone";
    await elb.send(new ModifyLoadBalancerAttributesCommand({ LoadBalancerArn: arn.raw, Attributes: [{ Key: "deletion_protection.enabled", Value: "false" }] }));
    await elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: arn.raw }));
    await pollUntil(ctx, `load balancer ${lbName(arn.resource)}`, async () => !(await exists()));
    return "deleted";
  },
};

const targetGroup: Handler = {
  id: "elbv2:targetgroup",
  rank: 30,
  match: (a) => (a.service === "elasticloadbalancing" && a.resource.startsWith("targetgroup/") ? { name: a.resource.split("/")[1] } : null),
  async remove(ctx, arn) {
    const elb = ctx.access.client(ElasticLoadBalancingV2Client, { region: regionOf(arn, ctx) });
    return retryInUse(ctx, `target group ${arn.resource.split("/")[1]}`, async () => void (await elb.send(new DeleteTargetGroupCommand({ TargetGroupArn: arn.raw }))));
  },
};

/* ----------------------------------- RDS ---------------------------------- */

const rdsInstance: Handler = {
  id: "rds:db",
  rank: 40,
  match: (a) => {
    const name = svc(a, "rds", "db:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const rds = ctx.access.client(RDSClient, { region: regionOf(arn, ctx) });
    const id = arn.resource.slice("db:".length);
    const describe = async () => {
      try {
        return (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))).DBInstances?.[0];
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    };
    const db = await describe();
    if (!db) return "already_gone";
    if (db.DeletionProtection) await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: id, DeletionProtection: false, ApplyImmediately: true }));
    if (db.DBInstanceStatus !== "deleting") {
      // No final snapshot: permitted only because the run tag was verified above.
      await retryInUse(ctx, `RDS instance ${id}`, async () => void (await rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: id, SkipFinalSnapshot: true, DeleteAutomatedBackups: true }))));
    }
    await pollUntil(ctx, `RDS instance ${id}`, async () => (await describe()) === undefined);
    return "deleted";
  },
};

const rdsCluster: Handler = {
  id: "rds:cluster",
  rank: 41,
  match: (a) => {
    const name = svc(a, "rds", "cluster:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const rds = ctx.access.client(RDSClient, { region: regionOf(arn, ctx) });
    const id = arn.resource.slice("cluster:".length);
    const describe = async () => {
      try {
        return (await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: id }))).DBClusters?.[0];
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    };
    const cluster = await describe();
    if (!cluster) return "already_gone";
    if (cluster.DeletionProtection) await rds.send(new ModifyDBClusterCommand({ DBClusterIdentifier: id, DeletionProtection: false, ApplyImmediately: true }));
    if (cluster.Status !== "deleting") {
      await retryInUse(ctx, `RDS cluster ${id}`, async () => void (await rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: id, SkipFinalSnapshot: true }))));
    }
    await pollUntil(ctx, `RDS cluster ${id}`, async () => (await describe()) === undefined);
    return "deleted";
  },
};

const rdsSnapshot: Handler = {
  id: "rds:snapshot",
  rank: 45,
  match: (a) => {
    const name = svc(a, "rds", "snapshot:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const rds = ctx.access.client(RDSClient, { region: regionOf(arn, ctx) });
    try {
      await rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: arn.resource.slice("snapshot:".length) }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const rdsSubnetGroup: Handler = {
  id: "rds:subgrp",
  rank: 80,
  match: (a) => {
    const name = svc(a, "rds", "subgrp:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn) {
    const rds = ctx.access.client(RDSClient, { region: regionOf(arn, ctx) });
    return retryInUse(ctx, "RDS subnet group", async () => void (await rds.send(new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: arn.resource.slice("subgrp:".length) }))));
  },
};

const rdsParameterGroup: Handler = {
  id: "rds:pg",
  rank: 81,
  match: (a) => {
    const name = svc(a, "rds", "pg:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn) {
    const rds = ctx.access.client(RDSClient, { region: regionOf(arn, ctx) });
    return retryInUse(ctx, "RDS parameter group", async () => void (await rds.send(new DeleteDBParameterGroupCommand({ DBParameterGroupName: arn.resource.slice("pg:".length) }))));
  },
};

/* -------------------------------- ElastiCache ------------------------------- */

const cacheReplicationGroup: Handler = {
  id: "elasticache:replicationgroup",
  rank: 50,
  match: (a) => {
    const name = svc(a, "elasticache", "replicationgroup:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const ec = ctx.access.client(ElastiCacheClient, { region: regionOf(arn, ctx) });
    const id = arn.resource.slice("replicationgroup:".length);
    const exists = async () => {
      try {
        return ((await ec.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }))).ReplicationGroups?.length ?? 0) > 0;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    };
    if (!(await exists())) return "already_gone";
    await retryInUse(ctx, `ElastiCache replication group ${id}`, async () => void (await ec.send(new DeleteReplicationGroupCommand({ ReplicationGroupId: id, RetainPrimaryCluster: false }))));
    await pollUntil(ctx, `ElastiCache replication group ${id}`, async () => !(await exists()));
    return "deleted";
  },
};

const cacheCluster: Handler = {
  id: "elasticache:cluster",
  rank: 51,
  match: (a) => {
    const name = svc(a, "elasticache", "cluster:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const ec = ctx.access.client(ElastiCacheClient, { region: regionOf(arn, ctx) });
    const id = arn.resource.slice("cluster:".length);
    const describe = async () => {
      try {
        return (await ec.send(new DescribeCacheClustersCommand({ CacheClusterId: id }))).CacheClusters?.[0];
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    };
    const cluster = await describe();
    if (!cluster) return "already_gone";
    // A node of a replication group goes with the group; deleting it alone is refused by the service.
    if (cluster.ReplicationGroupId) return "covered_by_parent";
    await retryInUse(ctx, `ElastiCache cluster ${id}`, async () => void (await ec.send(new DeleteCacheClusterCommand({ CacheClusterId: id }))));
    await pollUntil(ctx, `ElastiCache cluster ${id}`, async () => (await describe()) === undefined);
    return "deleted";
  },
};

const cacheSubnetGroup: Handler = {
  id: "elasticache:subnetgroup",
  rank: 82,
  match: (a) => {
    const name = svc(a, "elasticache", "subnetgroup:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn) {
    const ec = ctx.access.client(ElastiCacheClient, { region: regionOf(arn, ctx) });
    return retryInUse(ctx, "ElastiCache subnet group", async () => void (await ec.send(new DeleteCacheSubnetGroupCommand({ CacheSubnetGroupName: arn.resource.slice("subnetgroup:".length) }))));
  },
};

/* ------------------------------ storage and misc ---------------------------- */

const s3Bucket: Handler = {
  id: "s3:bucket",
  rank: 70,
  match: (a) => (a.service === "s3" && a.resource !== "" && !a.resource.includes("/") ? { name: a.resource } : null),
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const bucket = arn.resource;
    if (bucket.startsWith(STATE_BUCKET_PREFIX)) throw new Error(`${bucket} is a Zenith state bucket; the harness never deletes it.`);
    const s3 = ctx.access.client(S3Client, { region: regionOf(arn, ctx) });
    try {
      // Empty it: every version and delete marker, then in-flight multipart uploads.
      for (;;) {
        const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
        const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((o) => (o.Key === undefined ? [] : [{ Key: o.Key, VersionId: o.VersionId }]));
        if (objects.length === 0) break;
        const out = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        if ((out.Errors?.length ?? 0) > 0) throw new Error(`S3 refused to delete ${out.Errors!.length} object version(s) in ${bucket} (${out.Errors![0]?.Code ?? "error"}).`);
      }
      for (;;) {
        const uploads = (await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [];
        if (uploads.length === 0) break;
        for (const u of uploads) if (u.Key && u.UploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }));
      }
      return await retryInUse(ctx, `S3 bucket ${bucket}`, async () => void (await s3.send(new DeleteBucketCommand({ Bucket: bucket }))), 3);
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const sqsQueue: Handler = {
  id: "sqs:queue",
  rank: 71,
  match: (a) => (a.service === "sqs" && a.resource !== "" ? { name: a.resource } : null),
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const sqs = ctx.access.client(SQSClient, { region: regionOf(arn, ctx) });
    try {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: arn.resource, QueueOwnerAWSAccountId: arn.account }));
      if (!QueueUrl) return "already_gone";
      await sqs.send(new DeleteQueueCommand({ QueueUrl }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const logGroup: Handler = {
  id: "logs:log-group",
  rank: 72,
  match: (a) => {
    const rest = svc(a, "logs", "log-group:");
    return rest === null ? null : { name: rest.replace(/:\*$/, "") };
  },
  async remove(ctx, arn) {
    const logs = ctx.access.client(CloudWatchLogsClient, { region: regionOf(arn, ctx) });
    try {
      await logs.send(new DeleteLogGroupCommand({ logGroupName: arn.resource.slice("log-group:".length).replace(/:\*$/, "") }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const ecrRepository: Handler = {
  id: "ecr:repository",
  rank: 73,
  match: (a) => {
    const name = svc(a, "ecr", "repository/");
    return name === null ? null : { name };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const ecr = ctx.access.client(ECRClient, { region: regionOf(arn, ctx) });
    try {
      await ecr.send(new DeleteRepositoryCommand({ repositoryName: arn.resource.slice("repository/".length), force: true }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const secret: Handler = {
  id: "secretsmanager:secret",
  rank: 74,
  // The ARN's name carries a random 6-character suffix: `name-AbCdEf`.
  match: (a) => {
    const name = svc(a, "secretsmanager", "secret:");
    return name === null ? null : { name: name.replace(/-[A-Za-z0-9]{6}$/, "") };
  },
  async remove(ctx, arn, tags) {
    requireVerified(ctx, arn, tags);
    const sm = ctx.access.client(SecretsManagerClient, { region: regionOf(arn, ctx) });
    try {
      await sm.send(new DeleteSecretCommand({ SecretId: arn.raw, ForceDeleteWithoutRecovery: true }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const alarm: Handler = {
  id: "cloudwatch:alarm",
  rank: 75,
  match: (a) => {
    const name = svc(a, "cloudwatch", "alarm:");
    return name === null ? null : { name };
  },
  async remove(ctx, arn) {
    const cw = ctx.access.client(CloudWatchClient, { region: regionOf(arn, ctx) });
    await cw.send(new DeleteAlarmsCommand({ AlarmNames: [arn.resource.slice("alarm:".length)] }));
    return "deleted";
  },
};

const lambdaFunction: Handler = {
  id: "lambda:function",
  rank: 76,
  match: (a) => {
    const rest = svc(a, "lambda", "function:");
    return rest === null ? null : { name: rest.split(":")[0] };
  },
  async remove(ctx, arn) {
    const lambda = ctx.access.client(LambdaClient, { region: regionOf(arn, ctx) });
    try {
      await lambda.send(new DeleteFunctionCommand({ FunctionName: arn.resource.slice("function:".length).split(":")[0] }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

const acmCertificate: Handler = {
  id: "acm:certificate",
  rank: 85,
  // A certificate has no name of its own; the tag is the only guard.
  match: (a) => (svc(a, "acm", "certificate/") === null ? null : {}),
  async remove(ctx, arn) {
    const acm = ctx.access.client(ACMClient, { region: regionOf(arn, ctx) });
    return retryInUse(ctx, "ACM certificate", async () => void (await acm.send(new DeleteCertificateCommand({ CertificateArn: arn.raw }))));
  },
};

const iamRole: Handler = {
  id: "iam:role",
  rank: 90,
  match: (a) => {
    const rest = svc(a, "iam", "role/");
    return rest === null ? null : { name: lastSegment(rest) };
  },
  async remove(ctx, arn) {
    const iam = ctx.access.client(IAMClient, { region: ctx.listedRegion });
    const RoleName = lastSegment(arn.resource);
    try {
      for (const p of (await iam.send(new ListAttachedRolePoliciesCommand({ RoleName }))).AttachedPolicies ?? []) {
        if (p.PolicyArn) await iam.send(new DetachRolePolicyCommand({ RoleName, PolicyArn: p.PolicyArn }));
      }
      for (const PolicyName of (await iam.send(new ListRolePoliciesCommand({ RoleName }))).PolicyNames ?? []) {
        await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName }));
      }
      for (const ip of (await iam.send(new ListInstanceProfilesForRoleCommand({ RoleName }))).InstanceProfiles ?? []) {
        if (ip.InstanceProfileName) await iam.send(new RemoveRoleFromInstanceProfileCommand({ RoleName, InstanceProfileName: ip.InstanceProfileName }));
      }
      await iam.send(new DeleteRoleCommand({ RoleName }));
      return "deleted";
    } catch (e) {
      if (isNotFound(e)) return "already_gone";
      throw e;
    }
  },
};

/** Every handler, in no particular order; the cleaner sorts by rank. */
export const HANDLERS: readonly Handler[] = [
  ecsService,
  elbListener,
  elbListenerRule,
  loadBalancer,
  targetGroup,
  rdsInstance,
  rdsCluster,
  rdsSnapshot,
  cacheReplicationGroup,
  cacheCluster,
  ecsCluster,
  ecsTaskDefinition,
  s3Bucket,
  sqsQueue,
  logGroup,
  ecrRepository,
  secret,
  alarm,
  lambdaFunction,
  rdsSubnetGroup,
  rdsParameterGroup,
  cacheSubnetGroup,
  acmCertificate,
  iamRole,
  ...EC2_HANDLERS,
];

export interface Resolved {
  handler: Handler;
  name?: string;
}

/** The handler for an ARN, or undefined when this harness has no deleter for the type (reported, never guessed). */
export function resolveHandler(arn: Arn, handlers: readonly Handler[] = HANDLERS): Resolved | undefined {
  for (const handler of handlers) {
    const m = handler.match(arn);
    if (m) return { handler, name: m.name };
  }
  return undefined;
}

export type { DeleteResult };
