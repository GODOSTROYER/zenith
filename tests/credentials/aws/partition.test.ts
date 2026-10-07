/**
 * Partition contract for aws, aws-cn and aws-us-gov. CONTRACT-LEVEL ONLY: nothing
 * here registers a sovereign connection or touches a cloud; live sovereign
 * acceptance needs a China or GovCloud account and is deferred.
 */
import { describe, expect, it } from "vitest";
import {
  AWS_PARTITIONS, AWS_PARTITION_DNS_SUFFIX, AWS_SERVICE_PRINCIPAL_SERVICES, AwsPartitionError, assertSamePartition, awsArn, awsPartitionForRegion,
  awsServicePrincipal, iamPolicyArn, iamRoleArn, kmsKeyArn, partitionOfArn, principalForPartition, route53ZoneArn, s3BucketArn, serviceOfCommercialPrincipal,
} from "@/lib/credentials/aws/partition";
import { AWS_ROLE_BOUNDARIES, awsBootstrapContextForConnection, resolveAwsRoleBoundaries, roleFamilyPatterns } from "@/lib/credentials/aws/naming";
import { assumeRoleJson } from "@/lib/providers/aws/drivers/compute/support/tf";
import { parseRoleArn } from "@/lib/credentials/aws/arn";
import { trustPrincipalFor } from "@/lib/providers/aws/drivers/data/iam-role";
import type { ResourceNode } from "@/lib/resources/types";
import type { AwsConnectionConfig } from "@/lib/credentials/types";

const ACCOUNT = "123456789012";

describe("region to partition", () => {
  it.each([["us-east-1", "aws"], ["ap-southeast-2", "aws"], ["eu-central-1", "aws"], ["cn-north-1", "aws-cn"], ["cn-northwest-1", "aws-cn"], ["us-gov-west-1", "aws-us-gov"], ["us-gov-east-1", "aws-us-gov"]])("%s is %s", (region, partition) => {
    expect(awsPartitionForRegion(region)).toBe(partition);
  });

  it.each(["", "us-iso-east-1", "us-isob-east-1", "US-EAST-1", "us_east_1", "x", "us-east-1 ", "us-east-1\n"])("refuses %j without echoing it", (region) => {
    expect(() => awsPartitionForRegion(region)).toThrow(AwsPartitionError);
    try { awsPartitionForRegion(region); } catch (error) { expect(String((error as Error).message)).not.toContain(region.trim() || "never-empty-match"); }
  });
  it.each([undefined, null, 1, {}])("refuses non-string region %j", (region) => expect(() => awsPartitionForRegion(region)).toThrow(AwsPartitionError));
});

describe("service principals", () => {
  it("renders every reviewed service as <service>.amazonaws.com in aws and aws-us-gov", () => {
    for (const service of AWS_SERVICE_PRINCIPAL_SERVICES) {
      expect(awsServicePrincipal("aws", service)).toBe(`${service}.amazonaws.com`);
      expect(awsServicePrincipal("aws-us-gov", service)).toBe(`${service}.amazonaws.com`);
    }
  });
  it("uses the China DNS suffix for EC2 only", () => {
    expect(awsServicePrincipal("aws-cn", "ec2")).toBe("ec2.amazonaws.com.cn");
    for (const service of AWS_SERVICE_PRINCIPAL_SERVICES.filter((s) => s !== "ec2")) expect(awsServicePrincipal("aws-cn", service)).toBe(`${service}.amazonaws.com`);
  });
  it("refuses a service outside the reviewed table and a malformed partition", () => {
    expect(() => awsServicePrincipal("aws", "s3")).toThrow(AwsPartitionError);
    expect(() => awsServicePrincipal("aws", "ec2.amazonaws.com.evil")).toThrow(AwsPartitionError);
    expect(() => awsServicePrincipal("aws-iso" as never, "ec2")).toThrow(AwsPartitionError);
  });
  it("round-trips commercial principals and refuses foreign ones", () => {
    expect(serviceOfCommercialPrincipal("ecs-tasks.amazonaws.com")).toBe("ecs-tasks");
    expect(serviceOfCommercialPrincipal("ec2.amazonaws.com.cn")).toBeUndefined();
    expect(principalForPartition("aws-cn", "ec2.amazonaws.com")).toBe("ec2.amazonaws.com.cn");
    expect(() => principalForPartition("aws-cn", "evil.example.com")).toThrow(AwsPartitionError);
  });
  it("exposes each partition's endpoint DNS suffix", () => {
    expect(AWS_PARTITION_DNS_SUFFIX).toEqual({ aws: "amazonaws.com", "aws-cn": "amazonaws.com.cn", "aws-us-gov": "amazonaws.com" });
  });
});

describe.each(AWS_PARTITIONS)("ARNs in %s", (partition) => {
  it("builds exact, parseable identifiers", () => {
    const role = iamRoleArn(partition, ACCOUNT, "zenith-env-1-role");
    expect(role).toBe(`arn:${partition}:iam::${ACCOUNT}:role/zenith-env-1-role`);
    expect(parseRoleArn(role)).toMatchObject({ partition, accountId: ACCOUNT, name: "zenith-env-1-role" });
    expect(iamPolicyArn(partition, ACCOUNT, "ZenithAppBoundary-team-a")).toBe(`arn:${partition}:iam::${ACCOUNT}:policy/ZenithAppBoundary-team-a`);
    expect(kmsKeyArn(partition, "us-east-1", ACCOUNT, "11111111-2222-3333-4444-555555555555")).toBe(`arn:${partition}:kms:us-east-1:${ACCOUNT}:key/11111111-2222-3333-4444-555555555555`);
    expect(s3BucketArn(partition, "zenith-state-123456789012-us-east-1")).toBe(`arn:${partition}:s3:::zenith-state-123456789012-us-east-1`);
    expect(route53ZoneArn(partition, "Z0123456789ABC")).toBe(`arn:${partition}:route53:::hostedzone/Z0123456789ABC`);
    expect(partitionOfArn(role)).toBe(partition);
  });

  it("derives all six family boundaries and keeps every one in the partition, with and without a suffix", () => {
    for (const bootstrapNameSuffix of ["", `-${"a".repeat(19)}`]) {
      const arns = resolveAwsRoleBoundaries({ accountId: ACCOUNT, partition, bootstrapNameSuffix });
      expect(() => assertSamePartition(partition, Object.values(arns))).not.toThrow();
      for (const [family, spec] of Object.entries(AWS_ROLE_BOUNDARIES)) expect(arns[family as keyof typeof arns]).toBe(iamPolicyArn(partition, ACCOUNT, `${spec.policyName}${bootstrapNameSuffix}`));
    }
  });

  it("renders the family principal patterns for the partition's role ARNs", () => {
    for (const family of Object.keys(AWS_ROLE_BOUNDARIES) as (keyof typeof AWS_ROLE_BOUNDARIES)[]) {
      for (const pattern of roleFamilyPatterns(family)) expect(`arn:${partition}:iam::${ACCOUNT}:role/${pattern}`).toMatch(new RegExp(`^arn:${partition}:iam::\\d{12}:role/zenith-\\*-`));
    }
  });
});

describe("partition mixing is refused", () => {
  it("rejects one foreign or malformed ARN in an otherwise matching set", () => {
    const ok = iamRoleArn("aws", ACCOUNT, "r");
    expect(() => assertSamePartition("aws", [ok, iamRoleArn("aws-cn", ACCOUNT, "r")])).toThrow(AwsPartitionError);
    expect(() => assertSamePartition("aws", [ok, "arn:aws-iso:iam::123456789012:role/r"])).toThrow(AwsPartitionError);
    expect(() => assertSamePartition("aws", [ok, 5])).toThrow(AwsPartitionError);
  });
  it.each([["service", "S3"], ["region", "US-EAST-1"], ["account", "1234"], ["resource", "bad resource"]])("awsArn refuses an invalid %s", (segment, value) => {
    const args = { service: "iam", region: "", account: ACCOUNT, resource: "role/r", [segment]: value };
    expect(() => awsArn("aws", args.service, args.region, args.account, args.resource)).toThrow(AwsPartitionError);
  });
  it("keeps runtime registration commercial-only: a sovereign saved connection is still refused", () => {
    const base: AwsConnectionConfig = { provider: "aws", mode: "oidc_web_identity", accountId: ACCOUNT, region: "us-east-1", observeRoleArn: iamRoleArn("aws", ACCOUNT, "ZenithObserveRole"), deployRoleArn: iamRoleArn("aws", ACCOUNT, "ZenithDeployRole") };
    expect(awsBootstrapContextForConnection(base).partition).toBe("aws");
    expect(() => awsBootstrapContextForConnection({ ...base, region: "cn-north-1", observeRoleArn: iamRoleArn("aws-cn", ACCOUNT, "o"), deployRoleArn: iamRoleArn("aws-cn", ACCOUNT, "d") })).toThrow();
    expect(() => awsBootstrapContextForConnection({ ...base, region: "us-gov-west-1", observeRoleArn: iamRoleArn("aws-us-gov", ACCOUNT, "o"), deployRoleArn: iamRoleArn("aws-us-gov", ACCOUNT, "d") })).toThrow();
  });
});

describe("compiler trust policies", () => {
  const principalOf = (principal: string, ctx: Parameters<typeof assumeRoleJson>[1]) => JSON.parse(assumeRoleJson(principal, ctx).text).Statement[0].Principal.Service as string;

  it("keeps commercial output byte-identical to the historic static principal", () => {
    for (const service of ["ecs-tasks", "lambda", "codebuild", "events", "ec2"]) {
      expect(principalOf(`${service}.amazonaws.com`, { region: "us-east-1" })).toBe(`${service}.amazonaws.com`);
      expect(principalOf(`${service}.amazonaws.com`, undefined)).toBe(`${service}.amazonaws.com`);
    }
  });
  it("renders EC2 with the China suffix and everything else unchanged for a China region", () => {
    expect(principalOf("ec2.amazonaws.com", { region: "cn-north-1" })).toBe("ec2.amazonaws.com.cn");
    expect(principalOf("lambda.amazonaws.com", { region: "cn-north-1" })).toBe("lambda.amazonaws.com");
  });
  it("prefers the saved bootstrap context's partition over the region", () => {
    expect(principalOf("ec2.amazonaws.com", { region: "us-east-1", awsBootstrap: { accountId: ACCOUNT, partition: "aws-cn", bootstrapNameSuffix: "" } })).toBe("ec2.amazonaws.com.cn");
  });
  it("the IAM role driver's trust principal follows the partition and is unchanged for commercial regions", () => {
    const identity = { address: "identity/api" } as ResourceNode;
    const workload = (kind: string) => () => ({ kind }) as ResourceNode;
    expect(trustPrincipalFor(identity, { node: workload("compute_instance"), region: "us-east-1" }, "compute_instance/vm")).toBe("ec2.amazonaws.com");
    expect(trustPrincipalFor(identity, { node: workload("compute_instance"), region: "cn-north-1" }, "compute_instance/vm")).toBe("ec2.amazonaws.com.cn");
    expect(trustPrincipalFor(identity, { node: workload("container_service"), region: "cn-north-1" }, "container_service/web")).toBe("ecs-tasks.amazonaws.com");
    expect(trustPrincipalFor(identity, { node: workload("function") }, "function/fn")).toBe("lambda.amazonaws.com");
  });
  it("refuses a principal outside the reviewed table", () => {
    expect(() => assumeRoleJson("evil.example.com", { region: "us-east-1" })).toThrow(AwsPartitionError);
  });
});
