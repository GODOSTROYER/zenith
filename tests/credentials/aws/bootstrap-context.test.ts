import { describe, expect, it } from "vitest";
import { AWS_CONNECTION_REGIONS, AWS_ROLE_BOUNDARIES, awsBootstrapContextForConnection, isBootstrapNameSuffix, resolveAwsRoleBoundaries, type AwsBootstrapContext } from "@/lib/credentials/aws/naming";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { awsProvider } from "@/lib/providers/aws/provider";

const config: AwsConnectionConfig = { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserve-team-a", deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeploy-team-a" };

it("keeps connection region validation aligned with the existing commercial provider registration", () => expect([...AWS_CONNECTION_REGIONS]).toEqual(awsProvider.regions.map((region) => region.id)));

it.each(["", "-a", "-team-a", `-${"a".repeat(19)}`])("accepts exact bootstrap suffix %j", (suffix) => expect(isBootstrapNameSuffix(suffix)).toBe(true));
it.each([undefined, null, 1, "a", "-", "-A", "-a_b", "-a/b", " -a", "-a ", "-a\n", `-${"a".repeat(20)}`, "${file(\"x\")}"])("rejects malformed suffix without echo %j", (suffix) => {
  expect(isBootstrapNameSuffix(suffix)).toBe(false);
  expect(() => resolveAwsRoleBoundaries({ accountId: config.accountId, partition: "aws", bootstrapNameSuffix: suffix } as AwsBootstrapContext)).toThrow("AWS bootstrap identifiers are invalid.");
});

describe.each(["aws", "aws-cn", "aws-us-gov"] as const)("pure canonical rendering in %s", (partition) => {
  it.each(["", `-${"a".repeat(19)}`])("derives only six exact family ARNs with suffix %j", (bootstrapNameSuffix) => {
    const arns = resolveAwsRoleBoundaries({ accountId: config.accountId, partition, bootstrapNameSuffix });
    expect(Object.keys(arns).sort()).toEqual(Object.keys(AWS_ROLE_BOUNDARIES).sort());
    for (const [family, value] of Object.entries(AWS_ROLE_BOUNDARIES)) expect(arns[family as keyof typeof arns]).toBe(`arn:${partition}:iam::${config.accountId}:policy/${value.policyName}${bootstrapNameSuffix}`);
    expect(Object.isFrozen(arns)).toBe(true);
  });
});

it("defaults only from the saved suffix, never role names or legacy boundary ARN", () => {
  expect(awsBootstrapContextForConnection({ ...config, permissionsBoundaryArn: "arn:aws:iam::123456789012:policy/custom-team-a" }).bootstrapNameSuffix).toBe("");
  expect(awsBootstrapContextForConnection({ ...config, bootstrapNameSuffix: "-team-a" }).bootstrapNameSuffix).toBe("-team-a");
});
it.each([
  { accountId: "210987654321" }, { observeRoleArn: config.observeRoleArn.replace("arn:aws:", "arn:aws-cn:") },
  { deployRoleArn: config.deployRoleArn.replace("arn:aws:", "arn:aws-us-gov:") }, { region: "cn-north-1" }, { region: "us-gov-west-1" }, { bootstrapNameSuffix: "-bad/arn" },
  { codeBuildRoleArn: "arn:aws-cn:iam::123456789012:role/build" }, { codeBuildRoleArn: "arn:aws:iam::210987654321:role/build" },
  { stateKmsKeyArn: "arn:aws-cn:kms:cn-north-1:123456789012:key/abcd" }, { stateKmsKeyArn: "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/abcd" },
  { stateKmsKeyArn: "arn:aws:kms:us-east-1:210987654321:key/abcd" }, { stateKmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/abcd" },
])("refuses invalid saved runtime config %j", (over) => expect(() => awsBootstrapContextForConnection({ ...config, ...over })).toThrow());

it("validates state KMS in the backend region and CodeBuild in the saved account/partition", () => {
  expect(awsBootstrapContextForConnection({ ...config, stateKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/abcd", codeBuildRoleArn: "arn:aws:iam::123456789012:role/build" }, "ap-south-1")).toMatchObject({ accountId: config.accountId, bootstrapNameSuffix: "" });
});
