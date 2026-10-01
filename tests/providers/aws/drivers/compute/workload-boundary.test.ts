/**
 * Local permission intersections for the other boundary-carrying compute
 * roles. Existing blocked grants are characterized, never widened here.
 * Managed SSM actions are a v2 snapshot, not a live IAM policy fetch.
 */
import { describe, expect, it } from "vitest";
import { BUILD_ROLE_NAME_PATTERN } from "@/lib/credentials/aws/naming";
import { ec2InstanceDriver, ecsScheduledTaskDriver, ecsServiceDriver, lambdaFunctionDriver } from "@/lib/providers/aws/drivers/compute";
import { roleNameFor } from "@/lib/providers/aws/drivers/data/iam-role";
import { cloudName, refLocalName } from "@/lib/providers/aws/drivers/shared";
import { boundaryAllows, workloadBoundary } from "../../../../credentials/workload-boundary";
import { iamGlob } from "../../../../credentials/cfn";
import { BOUNDARY_ACCOUNT, BOUNDARY_PREFIX, policyRequests } from "./boundary-fixtures";
import { buildFullFixture, mkCompileContext, SECRET_ADDRESS } from "./fixtures";

const fixture = buildFullFixture();
const ctx = mkCompileContext(fixture.byAddress, { namePrefix: BOUNDARY_PREFIX });
const boundary = workloadBoundary();
const refs = {
  [`local.${refLocalName("container_registry/web", "arn")}`]: `arn:aws:ecr:eu-west-1:${BOUNDARY_ACCOUNT}:repository/${BOUNDARY_PREFIX}-web`,
  [`local.${refLocalName("log_group/web", "name")}`]: "/zenith/env_1/web",
  [`local.${refLocalName("log_group/nightly", "name")}`]: "/zenith/env_1/nightly",
  [`local.${refLocalName(SECRET_ADDRESS, "arn")}`]: `arn:aws:secretsmanager:eu-west-1:${BOUNDARY_ACCOUNT}:secret:zenith/env_1/db-url-ABC123`,
  [`local.${refLocalName("identity/nightly", "arn")}`]: `arn:aws:iam::${BOUNDARY_ACCOUNT}:role/${BOUNDARY_PREFIX}-nightly-role`,
  "aws_ecs_task_definition.scheduled_job_nightly.arn": `arn:aws:ecs:eu-west-1:${BOUNDARY_ACCOUNT}:task-definition/${BOUNDARY_PREFIX}-nightly:1`,
  "aws_iam_role.scheduled_job_nightly_exec.arn": `arn:aws:iam::${BOUNDARY_ACCOUNT}:role/${BOUNDARY_PREFIX}-nightly-exec`,
};

describe("other compute roles under the workload boundary", () => {
  it.each([
    ["ECS execution", ecsServiceDriver, fixture.service],
    ["Lambda execution", lambdaFunctionDriver, fixture.fn],
  ] as const)("allows every %s inline policy action and resource", (_name, driver, node) => {
    const fragment = driver.compile!(node, ctx);
    const requests = policyRequests(fragment, refs);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(boundaryAllows(boundary, request.action, request.resource), `${request.action} ${request.resource}`).toBe(true);
  });

  it("records the scheduled job's existing blocked RunTask/PassRole grants", () => {
    const requests = policyRequests(ecsScheduledTaskDriver.compile!(fixture.job, ctx), refs);
    const blocked = requests.filter((r) => !boundaryAllows(boundary, r.action, r.resource));
    expect([...new Set(blocked.map((r) => r.action))].sort()).toEqual(["ecs:RunTask", "iam:PassRole"]);
  });

  it("records the EC2 managed SSM policy's incomplete intersection without expanding it", () => {
    const fragment = ec2InstanceDriver.compile!(fixture.box, ctx);
    expect(Object.values(fragment.resource!.aws_iam_role_policy_attachment)[0].policy_arn).toContain("AmazonSSMManagedInstanceCore");
    // AWS-managed default v2, verified 2026-10-01:
    // https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonSSMManagedInstanceCore.html
    const unsupported = [
      "ssm:DescribeAssociation", "ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetDocument", "ssm:DescribeDocument", "ssm:GetManifest",
      "ssm:ListAssociations", "ssm:ListInstanceAssociations", "ssm:PutInventory", "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult",
      "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssm:UpdateInstanceInformation",
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
      "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
    ];
    expect(unsupported).toHaveLength(23);
    for (const action of unsupported) expect(boundaryAllows(boundary, action, "*"), action).toBe(false);
    for (const action of ["ssm:GetParameter", "ssm:GetParameters"]) {
      expect(boundaryAllows(boundary, action, `arn:aws:ssm:eu-west-1:${BOUNDARY_ACCOUNT}:parameter/zenith/env_1/key`), action).toBe(true);
      expect(boundaryAllows(boundary, action, `arn:aws:ssm:eu-west-1:${BOUNDARY_ACCOUNT}:parameter/aws/service/key`), action).toBe(false);
      expect(boundaryAllows(boundary, action, "*"), action).toBe(false);
    }
  });

  it.each(["web", "web-build", "x".repeat(180)])("application role names cannot acquire build permissions: %s", (name) => {
    const principalPattern = `arn:aws:iam::${BOUNDARY_ACCOUNT}:role/${BUILD_ROLE_NAME_PATTERN}`;
    const roles = [roleNameFor(ctx, `identity/${name}`), ...["exec", "fn", "ec2", "events"].map((suffix) => cloudName(ctx.namePrefix, `${name}-${suffix}`, 64))];
    for (const role of roles) {
      const principal = `arn:aws:iam::${BOUNDARY_ACCOUNT}:role/${role}`;
      expect(iamGlob(principalPattern, principal), role).toBe(false);
      expect(boundaryAllows(boundary, "ecr:PutImage", refs[`local.${refLocalName("container_registry/web", "arn")}`], { "aws:PrincipalArn": principal }), role).toBe(false);
      expect(boundaryAllows(boundary, "cloudfront:CreateInvalidation", `arn:aws:cloudfront::${BOUNDARY_ACCOUNT}:distribution/EWEB`, { "aws:PrincipalArn": principal, "aws:ResourceTag/zenith:managed": "true" }), role).toBe(false);
    }
  });

  it.each(["aws", "aws-cn", "aws-us-gov"])("uses the current partition for the principal and repository: %s", (partition) => {
    const statements = workloadBoundary(partition);
    expect(boundaryAllows(statements, "ecr:PutImage", `arn:${partition}:ecr:eu-west-1:${BOUNDARY_ACCOUNT}:repository/${BOUNDARY_PREFIX}-web`, {
      "aws:PrincipalArn": `arn:${partition}:iam::${BOUNDARY_ACCOUNT}:role/${BOUNDARY_PREFIX}-web-build`,
    })).toBe(true);
  });
});
