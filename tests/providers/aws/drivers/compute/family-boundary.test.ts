/** Local policy intersections, not live AWS acceptance. Managed attachments are
 * frozen action inventories checked against AWS documentation on 2026-10-01.
 * Resource fixtures name supported request resources, not the managed policies'
 * unrestricted '*' envelopes. Foreign resources remain deliberately blocked. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AWS_ROLE_BOUNDARIES, awsBoundaryArn, roleFamilyPatterns, resolveAwsRoleBoundaries, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import { codebuildProjectDriver, ec2InstanceDriver, ecsScheduledTaskDriver, ecsServiceDriver, lambdaFunctionDriver } from "@/lib/providers/aws/drivers/compute";
import { iamRoleDriver } from "@/lib/providers/aws/drivers/data/iam-role";
import { GRANT_RULES } from "@/lib/providers/aws/drivers/data/iam-grants";
import { compileEksCluster } from "@/lib/providers/aws/drivers/eks/eks-cluster";
import { vpcDriver } from "@/lib/providers/aws/drivers/network";
import { refLocalName } from "@/lib/providers/aws/drivers/shared";
import type { TofuFragment } from "@/lib/drivers/types";
import { boundaryAllows, familyBoundary } from "../../../../credentials/workload-boundary";
import { asList, iamGlob, statementsOf } from "../../../../credentials/cfn";
import { compileCtx, mkNode as dataNode, standardNodes } from "../data/_helpers";
import { buildFullFixture, mkCompileContext, mkNode, SECRET_ADDRESS } from "./fixtures";
import { BOUNDARY_ACCOUNT as ACCOUNT, BOUNDARY_PREFIX as PREFIX, policyRequests } from "./boundary-fixtures";
import ssmPolicy from "./amazon-ssm-managed-instance-core-v2.json";
import clusterPolicy from "../eks/amazon-eks-cluster-policy-v10.json";
import workerPolicy from "../eks/amazon-eks-worker-node-policy-v3.json";
import cniPolicy from "../eks/amazon-eks-cni-policy-v6.json";
import registryPolicy from "../eks/amazon-ec2-container-registry-read-only-v3.json";

const families = Object.keys(AWS_ROLE_BOUNDARIES) as AwsRoleFamily[];
const fixture = buildFullFixture();
const ctx = mkCompileContext(fixture.byAddress, { namePrefix: PREFIX });
const nodes = standardNodes();
nodes.push(
  dataNode("mysql/mysql", "mysql", {}),
  dataNode("provider_native/events", "pubsub", { type: "aws:sns_topic", config: {} }, { kind: "provider_native", nativeType: "aws:sns_topic" }),
);
const identity = nodes.find((node) => node.kind === "identity")!;
identity.spec.grants = [
  ...(identity.spec.grants as { target: string; access: string[]; via: string[] }[]),
  { target: "mysql/mysql", access: ["connect", "read_credentials"], via: ["test"] },
  { target: "provider_native/events", access: ["publish"], via: ["test"] },
];
const identityFragment = iamRoleDriver.compile!(identity, compileCtx(nodes, { namePrefix: PREFIX }));
const cluster = compileEksCluster(mkNode("kubernetes_cluster/apps", "kubernetes_cluster", "aws:eks_cluster", { version: "1.35" }, { dependsOn: ["subnet/private-a", "subnet/private-b"] }), ctx);
const flowNode = fixture.byAddress.get("network/main")!;
const flow = vpcDriver.compile!(flowNode, ctx);
const fragments: [string, TofuFragment][] = [
  ["ECS", ecsServiceDriver.compile!(fixture.service, ctx)],
  ["Lambda", lambdaFunctionDriver.compile!(fixture.fn, ctx)],
  ["scheduled", ecsScheduledTaskDriver.compile!(fixture.job, ctx)],
  ["machine", ec2InstanceDriver.compile!(fixture.box, ctx)],
  ["registry build", codebuildProjectDriver.compile!(fixture.pipeline, ctx)],
  ["site build", codebuildProjectDriver.compile!(fixture.siteBuild, ctx)],
  ["identity", identityFragment], ["EKS", cluster], ["flow", flow],
];

const attachmentFixtures = {
  AmazonSSMManagedInstanceCore: ssmPolicy,
  AmazonEKSClusterPolicy: clusterPolicy,
  AmazonEKSWorkerNodePolicy: workerPolicy,
  AmazonEKS_CNI_Policy: cniPolicy,
  AmazonEC2ContainerRegistryReadOnly: registryPolicy,
};

describe.each(["aws", "aws-cn", "aws-us-gov"] as const)("connection suffix rendering in %s (pure rendering only)", (partition) => {
  it.each(["", `-${"a".repeat(19)}`])("all eight role creators use canonical families for suffix %j and preserve role names", (bootstrapNameSuffix) => {
    const awsBootstrap = { accountId: ACCOUNT, partition, bootstrapNameSuffix };
    const trusted = { ...ctx, awsBootstrap };
    const suffixed: TofuFragment[] = [
      ecsServiceDriver.compile!(fixture.service, trusted), lambdaFunctionDriver.compile!(fixture.fn, trusted),
      ecsScheduledTaskDriver.compile!(fixture.job, trusted), ec2InstanceDriver.compile!(fixture.box, trusted),
      codebuildProjectDriver.compile!(fixture.pipeline, trusted), codebuildProjectDriver.compile!(fixture.siteBuild, trusted),
      iamRoleDriver.compile!(identity, compileCtx(nodes, { namePrefix: PREFIX, awsBootstrap })),
      compileEksCluster(mkNode("kubernetes_cluster/apps", "kubernetes_cluster", "aws:eks_cluster", { version: "1.35" }, { dependsOn: ["subnet/private-a", "subnet/private-b"] }), trusted),
      vpcDriver.compile!(flowNode, trusted),
    ];
    const canonical = resolveAwsRoleBoundaries(awsBootstrap);
    const seen = new Set<string>();
    suffixed.forEach((fragment, index) => {
      const oldRoles = fragments[index][1].resource!.aws_iam_role;
      for (const [label, role] of Object.entries(fragment.resource!.aws_iam_role)) {
        expect(role.name).toBe(oldRoles[label].name);
        const family = families.find((candidate) => String(oldRoles[label].permissions_boundary).endsWith(`:policy/${AWS_ROLE_BOUNDARIES[candidate].policyName}`))!;
        expect(role.permissions_boundary).toBe(canonical[family]);
        seen.add(family);
      }
    });
    expect([...seen].sort()).toEqual([...families].sort());
  });
});

function managedRequests(policy: unknown, partition: string, principal: string) {
  const arn = (service: string, resource: string) => `arn:${partition}:${service}:eu-west-1:${ACCOUNT}:${resource}`;
  const ec2 = (resource: string) => arn("ec2", `${resource}/fixture`);
  // EC2 multi-resource actions require authorization for every listed resource.
  // https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html
  const ec2Resources: Record<string, string[]> = {
    AttachVolume: ["instance", "volume"], DetachVolume: ["instance", "volume"],
    AuthorizeSecurityGroupIngress: ["security-group"], RevokeSecurityGroupIngress: ["security-group"],
    CreateSecurityGroup: ["security-group", "vpc"], DeleteSecurityGroup: ["security-group"],
    CreateRoute: ["route-table"], DeleteRoute: ["route-table"],
    CreateVolume: ["volume"], DeleteVolume: ["volume"], ModifyVolume: ["volume"], ModifyInstanceAttribute: ["instance"],
    CreateNetworkInterface: ["network-interface", "subnet", "security-group"],
    AttachNetworkInterface: ["network-interface", "instance"], DetachNetworkInterface: ["network-interface", "instance"],
    ModifyNetworkInterfaceAttribute: ["network-interface", "instance"], DeleteNetworkInterface: ["network-interface"],
    AssignPrivateIpAddresses: ["network-interface"], UnassignPrivateIpAddresses: ["network-interface"],
    CreateTags: principal.endsWith("-nodes") ? ["network-interface"] : ["instance", "volume", "security-group", "network-interface"],
  };
  return statementsOf(policy).flatMap((statement) => asList(statement.Action).flatMap((action) => {
    const context: Record<string, string | string[]> = {
      "aws:PrincipalArn": principal, "aws:ResourceTag/zenith:managed": "true", "aws:ResourceTag/zenith:environment": "env_1",
      "aws:TagKeys": ["node.k8s.amazonaws.com/instance_id", "node.k8s.amazonaws.com/createdAt", "cluster.k8s.amazonaws.com/name", "eks:eni:owner"],
      ...Object.fromEntries(Object.values(statement.Condition ?? {}).flatMap((entries) => Object.entries(entries))),
    };
    let resources: string[];
    const method = action.split(":")[1];
    if (action.startsWith("ec2:Describe") || action === "autoscaling:DescribeAutoScalingGroups" || action.startsWith("elasticloadbalancing:Describe") || action === "ecr:GetAuthorizationToken") resources = ["*"];
    else if (action.startsWith("ec2:")) {
      if (!ec2Resources[method]) throw new Error(`Missing EC2 request resource fixture: ${action}`);
      resources = ec2Resources[method].map(ec2);
    } else if (action.startsWith("elasticloadbalancing:")) {
      // Both classic and v2 actions are present in AmazonEKSClusterPolicy.
      // https://docs.aws.amazon.com/service-authorization/latest/reference/list_elb.html
      // https://docs.aws.amazon.com/service-authorization/latest/reference/list_awselasticloadbalancing.html
      const resource = /Target|RegisterTargets|DeregisterTargets/.test(method) ? "targetgroup/zenith-fixture/id"
        : /^(CreateListener|DeleteListener|ModifyListener)$/.test(method) ? "listener/app/zenith-fixture/id/id" : "loadbalancer/zenith-fixture";
      resources = [arn("elasticloadbalancing", resource)];
      if (method === "CreateListener") resources.push(arn("elasticloadbalancing", "loadbalancer/app/zenith-fixture/id"));
    } else if (action.startsWith("eks:") || action.startsWith("eks-auth:")) resources = [arn("eks", `cluster/${PREFIX}-apps`)];
    else if (action.startsWith("ecr:")) resources = [arn("ecr", `repository/${PREFIX}-web`), `arn:${partition}:ecr:eu-west-1:210987654321:repository/eks/pause`, `arn:${partition}:ecr:eu-west-1:210987654321:repository/amazon-k8s-cni`];
    else if (action === "kms:DescribeKey") resources = [arn("kms", "key/fixture")];
    else if (action === "autoscaling:UpdateAutoScalingGroup") resources = [arn("autoscaling", "autoScalingGroup:fixture:autoScalingGroupName/eks-fixture")];
    else if (action === "iam:CreateServiceLinkedRole") resources = [`arn:${partition}:iam::${ACCOUNT}:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing`];
    else if (action.startsWith("ssm:") || action.startsWith("ssmmessages:") || action.startsWith("ec2messages:")) {
      const scoped: Record<string, string> = {
        DescribeAssociation: arn("ssm", "association/fixture"), UpdateInstanceAssociationStatus: arn("ssm", "association/fixture"),
        GetDocument: `arn:${partition}:ssm:eu-west-1::document/AWS-RunShellScript`, DescribeDocument: `arn:${partition}:ssm:eu-west-1::document/AWS-RunShellScript`,
        UpdateAssociationStatus: `arn:${partition}:ssm:eu-west-1::document/AWS-RunShellScript`,
        GetParameter: arn("ssm", "parameter/zenith/env_1/key"), GetParameters: arn("ssm", "parameter/zenith/env_1/key"),
        ListInstanceAssociations: ec2("instance"), PutComplianceItems: ec2("instance"), UpdateInstanceInformation: ec2("instance"),
      };
      resources = [scoped[method] ?? "*"];
    } else throw new Error(`Uncovered attachment action: ${action}`);
    return resources.map((resource) => ({ action, resource, context }));
  }));
}

describe.each(["aws", "aws-cn", "aws-us-gov"])("every driver-created role under family boundaries in %s", (partition) => {
  const arn = (service: string, resource: string) => `arn:${partition}:${service}:eu-west-1:${ACCOUNT}:${resource}`;
  const refs: Record<string, string> = {};
  const ref = (address: string, attribute: string, value: string) => { refs[`local.${refLocalName(address, attribute)}`] = value; };
  ref("container_registry/web", "arn", arn("ecr", `repository/${PREFIX}-web`));
  for (const name of ["web", "nightly"]) {
    ref(`log_group/${name}`, "name", `/zenith/env_1/${name}`);
    ref(`log_group/${name}`, "arn", arn("logs", `log-group:/zenith/env_1/${name}:*`));
  }
  for (const address of [SECRET_ADDRESS, "secret/api-key-deadbeef"]) ref(address, "arn", arn("secretsmanager", "secret:zenith/env_1/key-ABC123"));
  ref("identity/nightly", "arn", `arn:${partition}:iam::${ACCOUNT}:role/${PREFIX}-nightly-role`);
  ref("object_store/uploads", "arn", `arn:${partition}:s3:::${PREFIX}-uploads`);
  ref("queue/jobs", "arn", arn("sqs", `${PREFIX}-jobs`));
  for (const address of ["postgres/db", "mysql/mysql"]) {
    ref(address, "master_user_secret_arn", arn("secretsmanager", "secret:rds!db-fixture-ABC123"));
    ref(address, "resource_id", "db-FIXTURE");
  }
  ref("redis/cache", "arn", arn("elasticache", `replicationgroup:${PREFIX}-cache`));
  ref("redis/cache", "iam_user_arn", arn("elasticache", `user:${PREFIX}-cache`));
  ref("provider_native/events", "arn", arn("sns", `${PREFIX}-events`));
  ref("provider_native/events", "kms_key_arn", arn("kms", "key/fixture"));
  ref(fixture.site.address, "bucket_arn", `arn:${partition}:s3:::${PREFIX}-docs-abcdef12`);
  ref(fixture.site.address, "distribution_arn", `arn:${partition}:cloudfront::${ACCOUNT}:distribution/EDOCS`);
  const boundaries = Object.fromEntries(families.map((family) => [family, familyBoundary(family, partition)])) as Record<AwsRoleFamily, ReturnType<typeof familyBoundary>>;
  const principals = Object.fromEntries(families.map((family) => [family, `arn:${partition}:iam::${ACCOUNT}:role/${PREFIX}-fixture${AWS_ROLE_BOUNDARIES[family].suffixes[0]}`])) as Record<AwsRoleFamily, string>;

  it.each(fragments)("%s: every emitted role's inline and managed actions intersect its own family, and reject all other family principals", (_name, fragment) => {
    const requests: { action: string; resource: string; context: Record<string, string | string[]> }[] = policyRequests(fragment, refs, partition);
    for (const attachment of Object.values(fragment.resource?.aws_iam_role_policy_attachment ?? {})) {
      const policyName = String(attachment.policy_arn).split("/").at(-1)!;
      const inventory = attachmentFixtures[policyName as keyof typeof attachmentFixtures];
      expect(inventory, `uncovered managed policy ${policyName}`).toBeDefined();
      const label = /^\$\{aws_iam_role\.([\w]+)\.name\}$/.exec(String(attachment.role))![1];
      const principal = `arn:${partition}:iam::${ACCOUNT}:role/${fragment.resource!.aws_iam_role[label].name}`;
      requests.push(...managedRequests(inventory, partition, principal));
    }
    for (const [label, role] of Object.entries(fragment.resource!.aws_iam_role)) {
      const principal = `arn:${partition}:iam::${ACCOUNT}:role/${role.name}`;
      const family = families.find((candidate) => String(role.permissions_boundary).endsWith(`:policy/${AWS_ROLE_BOUNDARIES[candidate].policyName}`))!;
      expect(family, label).toBeDefined();
      expect(roleFamilyPatterns(family).some((pattern) => iamGlob(pattern, String(role.name))), label).toBe(true);
      expect(String(role.permissions_boundary).replace(/\$\{data\.aws_partition\.[\w]+\.partition\}/g, partition).replace(/\$\{data\.aws_caller_identity\.[\w]+\.account_id\}/g, ACCOUNT)).toBe(awsBoundaryArn(family, partition, ACCOUNT));
      const ownRequests = requests.filter((request) => request.context["aws:PrincipalArn"] === principal);
      expect(ownRequests.length, `no policy coverage for ${label}`).toBeGreaterThan(0);
      for (const request of ownRequests) {
        const context = { "s3:ResourceAccount": ACCOUNT, "aws:ResourceTag/zenith:managed": "true", "kms:CallerAccount": ACCOUNT, "kms:ViaService": `sns.eu-west-1.${partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com"}`, ...request.context };
        expect(boundaryAllows(boundaries[family], request.action, request.resource, context), `${label}: ${request.action} ${request.resource}`).toBe(true);
        // Same family boundary refuses other principals, including shared actions.
        for (const other of families.filter((candidate) => candidate !== family)) expect(boundaryAllows(boundaries[family], request.action, request.resource, { ...context, "aws:PrincipalArn": principals[other] }), `${family} boundary used by ${other}: ${request.action}`).toBe(false);
        expect(boundaryAllows(boundaries[family], request.action, request.resource, { ...context, "aws:PrincipalArn": principal.replace(ACCOUNT, "210987654321") })).toBe(false);
      }
    }
  });

  it("covers every identity grant action, including both database engines, SNS KMS, multipart uploads, log reads and cache resource pair", () => {
    const requests = policyRequests(identityFragment, refs, partition);
    expect([...new Set(requests.map((request) => request.action))].sort()).toEqual([...new Set(Object.values(GRANT_RULES).flatMap((verbs) => Object.values(verbs).flatMap((rules) => rules.flatMap((rule) => rule.actions))))].sort());
    expect(requests.filter((request) => request.action === "elasticache:Connect")).toHaveLength(2);
    expect(requests.filter((request) => request.action === "rds-db:connect")).toHaveLength(2);
  });

  it("documents legitimate shared actions while keeping unique family rights isolated", () => {
    for (const family of ["app", "build", "eksNode"] as const) expect(boundaryAllows(boundaries[family], "ecr:GetAuthorizationToken", "*", { "aws:PrincipalArn": principals[family] })).toBe(true);
    for (const family of families.filter((family) => family !== "build")) expect(boundaryAllows(boundaries[family], "ecr:PutImage", arn("ecr", `repository/${PREFIX}-web`), { "aws:PrincipalArn": principals[family] })).toBe(false);
    for (const family of families.filter((family) => family !== "scheduler")) expect(boundaryAllows(boundaries[family], "ecs:RunTask", arn("ecs", `task-definition/${PREFIX}-nightly:1`), { "aws:PrincipalArn": principals[family], "ecs:cluster": arn("ecs", `cluster/${PREFIX}-nightly`) })).toBe(false);
    for (const family of families) {
      // Explicit foreign-principal denial also protects requests authorized
      // directly by a resource policy, beyond this local intersection check.
      expect(boundaries[family]).toContainEqual({
        Effect: "Deny", Action: "*", Resource: "*",
        Condition: { ArnNotLike: { "aws:PrincipalArn": roleFamilyPatterns(family).map((pattern) => `arn:${partition}:iam::${ACCOUNT}:role/${pattern}`) } },
      });
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePermissionsBoundary", "organizations:ListAccounts", "account:GetContactInformation"]) expect(boundaryAllows(boundaries[family], action, "*", { "aws:PrincipalArn": principals[family] })).toBe(false);
      expect(boundaryAllows(boundaries[family], "s3:GetObject", `arn:${partition}:s3:::zenith-state-${ACCOUNT}-eu-west-1/state.tf`, { "aws:PrincipalArn": principals[family], "s3:ResourceAccount": ACCOUNT })).toBe(false);
    }
  });
});

it("the role creator inventory includes every AWS driver source that creates roles", () => {
  const root = path.resolve("src/lib/providers/aws/drivers");
  const creators = fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".ts") && /\.resource\("aws_iam_role",/.test(fs.readFileSync(path.join(root, String(name)), "utf8"))).map(String).sort();
  expect(creators).toEqual(["compute/codebuild-project.ts", "compute/ec2-instance.ts", "compute/ecs-scheduled-task.ts", "compute/ecs-task.ts", "compute/lambda-function.ts", "data/iam-role.ts", "eks/eks-cluster.ts", "network/vpc-compile.ts"]);
});
