/**
 * Local permission intersections, not live AWS acceptance. The managed SSM
 * fixture is the published default v2 checked on 2026-10-01, not a live fetch:
 * https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html
 * Requests use the Service Authorization Reference's resource types. Parameter
 * reads deliberately stay zenith-only, despite the managed policy's '*'.
 */
import { describe, expect, it } from "vitest";
import { BUILD_ROLE_NAME_PATTERN, EC2_ROLE_NAME_PATTERN, EC2_ROLE_SUFFIX, EVENTS_ROLE_NAME_PATTERN, EVENTS_ROLE_SUFFIX } from "@/lib/credentials/aws/naming";
import { codebuildProjectDriver, ec2InstanceDriver, ecsScheduledTaskDriver, ecsServiceDriver, lambdaFunctionDriver } from "@/lib/providers/aws/drivers/compute";
import { roleNameFor } from "@/lib/providers/aws/drivers/data/iam-role";
import { GRANT_RULES } from "@/lib/providers/aws/drivers/data/iam-grants";
import { compileEksCluster } from "@/lib/providers/aws/drivers/eks/eks-cluster";
import { cloudName, refLocalName, tfLabel } from "@/lib/providers/aws/drivers/shared";
import { boundaryAllows, workloadBoundary } from "../../../../credentials/workload-boundary";
import { asList, iamGlob, statementsOf } from "../../../../credentials/cfn";
import { BOUNDARY_ACCOUNT as ACCOUNT, BOUNDARY_PREFIX as PREFIX, policyRequests } from "./boundary-fixtures";
import { buildFullFixture, mkCompileContext, mkNode, SECRET_ADDRESS } from "./fixtures";
import ssmPolicy from "./amazon-ssm-managed-instance-core-v2.json";

const fixture = buildFullFixture();
const ctx = mkCompileContext(fixture.byAddress, { namePrefix: PREFIX });
const partitions = ["aws", "aws-cn", "aws-us-gov"] as const;
const refsFor = (partition: string) => ({
  [`local.${refLocalName("container_registry/web", "arn")}`]: `arn:${partition}:ecr:eu-west-1:${ACCOUNT}:repository/${PREFIX}-web`,
  [`local.${refLocalName("log_group/web", "name")}`]: "/zenith/env_1/web",
  [`local.${refLocalName("log_group/nightly", "name")}`]: "/zenith/env_1/nightly",
  [`local.${refLocalName(SECRET_ADDRESS, "arn")}`]: `arn:${partition}:secretsmanager:eu-west-1:${ACCOUNT}:secret:zenith/env_1/db-url-ABC123`,
  [`local.${refLocalName("identity/nightly", "arn")}`]: `arn:${partition}:iam::${ACCOUNT}:role/${PREFIX}-nightly-role`,
});

function ssmRequests(partition: string) {
  const instance = `arn:${partition}:ec2:eu-west-1:${ACCOUNT}:instance/i-0123456789abcdef0`;
  const association = `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:association/01234567-89ab-cdef-0123-456789abcdef`;
  const document = `arn:${partition}:ssm:eu-west-1::document/AWS-RunShellScript`;
  const parameter = `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:parameter/zenith/env_1/key`;
  const resources: Record<string, string> = {
    "ssm:DescribeAssociation": association, "ssm:GetDocument": document,
    "ssm:DescribeDocument": document, "ssm:GetParameter": parameter, "ssm:GetParameters": parameter,
    "ssm:ListInstanceAssociations": instance, "ssm:PutComplianceItems": instance,
    "ssm:UpdateAssociationStatus": document, "ssm:UpdateInstanceAssociationStatus": association,
    "ssm:UpdateInstanceInformation": instance,
  };
  return statementsOf(ssmPolicy).flatMap((s) => asList(s.Action).map((action) => ({ action, resource: resources[action] ?? "*" })));
}

describe.each(partitions)("legacy migration boundary in %s", (partition) => {
  const boundary = workloadBoundary(partition);
  const refs = refsFor(partition);
  const job = ecsScheduledTaskDriver.compile!(fixture.job, ctx);
  const machine = ec2InstanceDriver.compile!(fixture.box, ctx);
  const eventsName = String(job.resource!.aws_iam_role.scheduled_job_nightly_events.name);
  const machineName = String(machine.resource!.aws_iam_role.compute_instance_bastion.name);
  const events = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/${eventsName}` };
  const ec2 = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/${machineName}`, "aws:ResourceTag/zenith:managed": "true" };
  const jobRequests = policyRequests(job, refs, partition);

  it.each([
    ["ECS execution", ecsServiceDriver, fixture.service],
    ["Lambda execution", lambdaFunctionDriver, fixture.fn],
    ["scheduled execution and invocation", ecsScheduledTaskDriver, fixture.job],
  ] as const)("allows every %s inline policy action/resource with emitted conditions", (_name, driver, node) => {
    const requests = policyRequests(driver.compile!(node, ctx), refs, partition);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(boundaryAllows(boundary, r.action, r.resource, r.context), `${r.action} ${r.resource}`).toBe(true);
    if (driver === ecsScheduledTaskDriver) {
      expect(requests.filter((r) => r.action === "iam:PassRole")).toHaveLength(2);
      expect(requests.filter((r) => r.action === "ecs:RunTask")).toHaveLength(1);
    }
  });

  it("allows all 25 managed SSM v2 actions at supported resources for the emitted EC2 principal", () => {
    const attachment = Object.values(machine.resource!.aws_iam_role_policy_attachment)[0];
    expect(attachment.policy_arn).toContain(":iam::aws:policy/AmazonSSMManagedInstanceCore");
    expect(attachment.role).toBe("${aws_iam_role.compute_instance_bastion.name}");
    expect(ssmRequests(partition)).toHaveLength(25);
    for (const r of ssmRequests(partition)) expect(boundaryAllows(boundary, r.action, r.resource, ec2), r.action).toBe(true);
    expect(iamGlob(`arn:${partition}:iam::${ACCOUNT}:role/${EC2_ROLE_NAME_PATTERN}`, ec2["aws:PrincipalArn"])).toBe(true);
    expect(iamGlob(`arn:${partition}:iam::${ACCOUNT}:role/${EVENTS_ROLE_NAME_PATTERN}`, events["aws:PrincipalArn"])).toBe(true);
  });

  it("conditions every new invocation and agent grant on its reserved principal", () => {
    const coreActions = ssmRequests(partition).map((r) => r.action).filter((a) => !["ssm:GetParameter", "ssm:GetParameters"].includes(a));
    const grants = boundary.filter((s) => s.Effect === "Allow" && asList(s.Action).some((pattern) => coreActions.some((a) => iamGlob(pattern, a)) || ["ecs:RunTask", "iam:PassRole"].includes(pattern)));
    expect(grants).toHaveLength(5);
    for (const grant of grants) {
      const family = asList(grant.Action).some((a) => ["ecs:RunTask", "iam:PassRole"].includes(a)) ? EVENTS_ROLE_NAME_PATTERN : EC2_ROLE_NAME_PATTERN;
      expect(grant.Condition?.ArnLike?.["aws:PrincipalArn"]).toBe(`arn:${partition}:iam::${ACCOUNT}:role/${family}`);
    }
  });

  it("rejects missing/foreign principals, clusters, roles and destination services", () => {
    const run = jobRequests.find((r) => r.action === "ecs:RunTask")!;
    const pass = jobRequests.find((r) => r.action === "iam:PassRole")!;
    for (const r of [run, pass]) {
      expect(boundaryAllows(boundary, r.action, r.resource, {})).toBe(false);
      expect(boundaryAllows(boundary, r.action, r.resource, { ...r.context, "aws:PrincipalArn": events["aws:PrincipalArn"].replace(ACCOUNT, "210987654321") })).toBe(false);
      for (const resource of ["*", r.resource.replace(ACCOUNT, "210987654321"), r.resource.replace("zenith-", "foreign-"), r.resource.replace(`arn:${partition}:`, "arn:wrong:")]) {
        expect(boundaryAllows(boundary, r.action, resource, r.context), resource).toBe(false);
      }
    }
    for (const cluster of [undefined, "*", run.context["ecs:cluster"].replace(ACCOUNT, "210987654321"), run.context["ecs:cluster"].replace("zenith-", "foreign-")]) {
      const context = { ...run.context };
      if (cluster === undefined) delete context["ecs:cluster"]; else context["ecs:cluster"] = cluster;
      expect(boundaryAllows(boundary, run.action, run.resource, context)).toBe(false);
    }
    for (const service of [undefined, "lambda.amazonaws.com", "codebuild.amazonaws.com", "ec2.amazonaws.com"]) {
      const context = { ...pass.context };
      if (service === undefined) delete context["iam:PassedToService"]; else context["iam:PassedToService"] = service;
      expect(boundaryAllows(boundary, pass.action, pass.resource, context)).toBe(false);
    }
  });

  it("rejects foreign SSM resources, untagged instances, hybrid nodes and non-zenith parameters", () => {
    for (const r of ssmRequests(partition)) {
      if (!["ssm:GetParameter", "ssm:GetParameters"].includes(r.action)) {
        expect(boundaryAllows(boundary, r.action, r.resource, {}), r.action).toBe(false);
        expect(boundaryAllows(boundary, r.action, r.resource, { ...ec2, "aws:PrincipalArn": ec2["aws:PrincipalArn"].replace(ACCOUNT, "210987654321") }), r.action).toBe(false);
      }
      if (r.resource === "*") continue;
      expect(boundaryAllows(boundary, r.action, "*", ec2), r.action).toBe(false);
      if (r.resource.includes(ACCOUNT)) expect(boundaryAllows(boundary, r.action, r.resource.replace(ACCOUNT, "210987654321"), ec2), r.action).toBe(false);
      if (r.resource.includes(":instance/")) {
        expect(boundaryAllows(boundary, r.action, r.resource, { "aws:PrincipalArn": ec2["aws:PrincipalArn"] }), r.action).toBe(false);
        expect(boundaryAllows(boundary, r.action, r.resource, { ...ec2, "aws:ResourceTag/zenith:managed": "false" }), r.action).toBe(false);
        expect(boundaryAllows(boundary, r.action, `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:managed-instance/mi-0123456789abcdef0`, ec2), r.action).toBe(false);
      }
    }
    for (const action of ["ssm:GetParameter", "ssm:GetParameters"]) {
      for (const path of ["aws/service/ami-amazon-linux-latest/al2023", "other/key", "zenith-other/key"]) expect(boundaryAllows(boundary, action, `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:parameter/${path}`, ec2)).toBe(false);
    }
    for (const action of ["ssm:GetDocument", "ssm:DescribeDocument", "ssm:DescribeAssociation", "ssm:UpdateAssociationStatus"]) {
      expect(boundaryAllows(boundary, action, `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:document/Zenith-MachineInspect`, ec2)).toBe(true);
      for (const name of ["Unrelated", "zenith-custom"]) expect(boundaryAllows(boundary, action, `arn:${partition}:ssm:eu-west-1:${ACCOUNT}:document/${name}`, ec2)).toBe(false);
      expect(boundaryAllows(boundary, action, `arn:${partition}:ssm:eu-west-1:210987654321:document/Zenith-MachineInspect`, ec2)).toBe(false);
    }
  });

  it("keeps IAM administration, command dispatch and state access denied", () => {
    const state = asList(boundary.find((s) => s.Effect === "Deny" && s.Action === "s3:*")!.Resource)[0];
    for (const context of [events, ec2]) {
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRolePermissionsBoundary", "organizations:ListAccounts", "account:GetContactInformation", "ssm:SendCommand", "ssm:StartSession", "ssm:PutParameter", "ecs:ExecuteCommand"]) expect(boundaryAllows(boundary, action, "*", context), action).toBe(false);
      for (const action of ["s3:GetObject", "s3:PutObject"]) expect(boundaryAllows(boundary, action, `${state}/file`, context)).toBe(false);
    }
  });

  it.each(["web", "web-events", "web-ec2", "web-build", "x".repeat(180), "web.events", "web/ec2"])("other emitted role families cannot acquire reserved grants: %s", (name) => {
    const roles = [roleNameFor(ctx, `identity/${name}`), ...[
      ecsServiceDriver.compile!({ ...fixture.service, address: `container_service/${name}` }, ctx),
      lambdaFunctionDriver.compile!({ ...fixture.fn, address: `function/${name}` }, ctx),
      codebuildProjectDriver.compile!({ ...fixture.pipeline, address: `build_pipeline/${name}` }, ctx),
      compileEksCluster(mkNode(`kubernetes_cluster/${name}`, "kubernetes_cluster", "aws:eks_cluster", { version: "1.35" }, { dependsOn: ["subnet/private-a", "subnet/private-b"] }), ctx),
    ].flatMap((f) => Object.values(f.resource!.aws_iam_role).map((r) => String(r.name)))];
    const reservedRequests = [
      ...jobRequests.filter((r) => ["ecs:RunTask", "iam:PassRole"].includes(r.action)),
      ...ssmRequests(partition).filter((r) => !["ssm:GetParameter", "ssm:GetParameters"].includes(r.action)).map((r) => ({ ...r, context: ec2 })),
    ];
    for (const role of roles) {
      const principal = `arn:${partition}:iam::${ACCOUNT}:role/${role}`;
      for (const pattern of [EVENTS_ROLE_NAME_PATTERN, EC2_ROLE_NAME_PATTERN]) expect(iamGlob(`arn:${partition}:iam::${ACCOUNT}:role/${pattern}`, principal), role).toBe(false);
      for (const r of reservedRequests) expect(boundaryAllows(boundary, r.action, r.resource, { ...r.context, "aws:PrincipalArn": principal }), `${role}: ${r.action}`).toBe(false);
    }
  });

  it("keeps the legacy identity and EKS gaps explicit during migration", () => {
    const identity = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/${roleNameFor(ctx, "identity/web")}` };
    const blockedIdentity = [
      ...GRANT_RULES.object_store.write.flatMap((r) => r.actions).filter((a) => a !== "s3:PutObject").map((action) => ({ action, resource: `arn:${partition}:s3:::${PREFIX}-web/file` })),
      ...GRANT_RULES.log_group.logs.flatMap((r) => r.actions).filter((a) => a !== "logs:DescribeLogStreams").map((action) => ({ action, resource: `arn:${partition}:logs:eu-west-1:${ACCOUNT}:log-group:/zenith/env_1/web:log-stream:web` })),
      ...GRANT_RULES.postgres.connect.flatMap((r) => r.actions).map((action) => ({ action, resource: `arn:${partition}:rds-db:eu-west-1:${ACCOUNT}:dbuser:db-EXAMPLE/zenith_app` })),
      ...GRANT_RULES.redis.connect.flatMap((r) => r.actions).map((action) => ({ action, resource: `arn:${partition}:elasticache:eu-west-1:${ACCOUNT}:replicationgroup:${PREFIX}-cache` })),
      ...GRANT_RULES.postgres.read_credentials.flatMap((r) => r.actions).map((action) => ({ action, resource: `arn:${partition}:secretsmanager:eu-west-1:${ACCOUNT}:secret:rds!db-example-ABC123` })),
    ];
    expect(blockedIdentity).toHaveLength(8);
    for (const r of blockedIdentity) expect(boundaryAllows(boundary, r.action, r.resource, identity), r.action).toBe(false);
    // AmazonEKSClusterPolicy default v10, checked 2026-10-01. Representative
    // blocked actions, not a claim that every attachment/action was surveyed:
    // https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonEKSClusterPolicy.html
    const cluster = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/${PREFIX}-apps-cluster` };
    for (const action of ["autoscaling:DescribeAutoScalingGroups", "ec2:DescribeDhcpOptions", "ec2:CreateVolume", "elasticloadbalancing:CreateLoadBalancer", "iam:CreateServiceLinkedRole"]) expect(boundaryAllows(boundary, action, "*", cluster), action).toBe(false);
    const nodes = { "aws:PrincipalArn": `arn:${partition}:iam::${ACCOUNT}:role/${PREFIX}-apps-nodes` };
    // AmazonEC2ContainerRegistryReadOnly v3 includes metadata that the boundary
    // blocks even though repository pull remains permitted.
    expect(boundaryAllows(boundary, "ecr:DescribeRepositories", refs[`local.${refLocalName("container_registry/web", "arn")}`], nodes)).toBe(false);
  });

  it("keeps events, EC2 and build grants separate", () => {
    for (const r of ssmRequests(partition).filter((r) => !["ssm:GetParameter", "ssm:GetParameters"].includes(r.action))) expect(boundaryAllows(boundary, r.action, r.resource, { ...ec2, ...events }), r.action).toBe(false);
    for (const r of jobRequests.filter((r) => ["ecs:RunTask", "iam:PassRole"].includes(r.action))) expect(boundaryAllows(boundary, r.action, r.resource, { ...r.context, ...ec2 }), r.action).toBe(false);
    for (const principal of [events["aws:PrincipalArn"], ec2["aws:PrincipalArn"]]) {
      expect(iamGlob(`arn:${partition}:iam::${ACCOUNT}:role/${BUILD_ROLE_NAME_PATTERN}`, principal)).toBe(false);
      expect(boundaryAllows(boundary, "ecr:PutImage", refs[`local.${refLocalName("container_registry/web", "arn")}`], { "aws:PrincipalArn": principal })).toBe(false);
    }
  });
});

describe("reserved principal names", () => {
  it.each(["nightly", "web-events", "web-ec2", "x".repeat(180), "web.events/ec2"])("preserves the events/EC2 suffix for %s", (name) => {
    for (const [driver, node, suffix] of [[ecsScheduledTaskDriver, fixture.job, EVENTS_ROLE_SUFFIX], [ec2InstanceDriver, fixture.box, EC2_ROLE_SUFFIX]] as const) {
      const renamed = { ...node, address: `${node.kind}/${name}` };
      const fragment = driver.compile!(renamed, ctx);
      const label = `${tfLabel(renamed.address)}${driver === ecsScheduledTaskDriver ? "_events" : ""}`;
      const role = fragment.resource!.aws_iam_role[label];
      expect(role.name).toBe(`${cloudName(PREFIX, name, 64 - suffix.length)}${suffix}`);
      expect(String(role.name).length).toBeLessThanOrEqual(64);
      expect(role.permissions_boundary).toContain(driver === ecsScheduledTaskDriver ? "ZenithSchedulerBoundary" : "ZenithMachineBoundary");
      expect(role.tags).toMatchObject({ Name: role.name, "zenith:managed": "true" });
      expect(driver.compile!(renamed, ctx)).toEqual(fragment);
    }
  });
  it("keeps existing short names stable", () => {
    expect(ecsScheduledTaskDriver.compile!(fixture.job, ctx).resource!.aws_iam_role.scheduled_job_nightly_events.name).toBe(`${PREFIX}-nightly-events`);
    expect(ec2InstanceDriver.compile!(fixture.box, ctx).resource!.aws_iam_role.compute_instance_bastion.name).toBe(`${PREFIX}-bastion-ec2`);
  });
});
