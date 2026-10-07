/**
 * Identifier and count limits for the AWS bootstrap contract, including the
 * hosted-zone overflow split that the OpenTofu module renders, pinned to the
 * module's literals. Contract-level: no cloud call and no OpenTofu process.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AWS_REGION_NAME_MAX, AwsLimitError, DEPLOY_ROLE_BASE_MANAGED_POLICIES, ENVIRONMENT_ID_MAX, ROUTE53_OVERFLOW_POLICIES_MAX, ROUTE53_ZONES_INLINE_MAX, ROUTE53_ZONES_MAX,
  ROUTE53_ZONES_PER_OVERFLOW_POLICY, assertAwsBootstrapLimits, assertEnvironmentIdFits, assertRoleNameFits, planRoute53Zones, preflightRoleCapacity, roleNameBaseBudget,
  sampleLongestRoute53ZoneArns, stateBucketNameFor,
} from "@/lib/credentials/aws/limits";
import { AWS_PARTITIONS } from "@/lib/credentials/aws/partition";
import { IAM_MANAGED_POLICY_MAX_CHARS, IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA, compactPolicySize } from "@/lib/credentials/aws/policy-budget";
import { AWS_ROLE_BOUNDARIES, environmentName, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import { awsBootstrapPreflightSessionPolicy } from "@/lib/credentials/aws/bootstrap-preflight";
import { SessionPolicyError } from "@/lib/credentials/aws/policy";
import { findDriver } from "@/lib/drivers/types";
import { registerAwsDrivers } from "@/lib/providers/aws/drivers";
import type { AwsConnectionConfig } from "@/lib/credentials/types";
import { boundarySizes, checkBoundarySizes, overflowPolicySize } from "../../../deploy/aws/tools/generate-tofu-policies";
import { compileContext, expanded } from "../../providers/aws/drivers/_integration";

const MODULE = path.resolve(__dirname, "../../../deploy/aws/tofu-module");
const FAMILIES = Object.keys(AWS_ROLE_BOUNDARIES) as AwsRoleFamily[];
const MAX_SUFFIX = `-${"a".repeat(19)}`;
const MAX_ENV = "e".repeat(ENVIRONMENT_ID_MAX);

describe("environment ids and bootstrap suffix", () => {
  it("accepts the maximum environment id and suffix together in every region length", () => {
    expect(() => assertAwsBootstrapLimits({ environmentId: MAX_ENV, bootstrapNameSuffix: MAX_SUFFIX, accountId: "123456789012" })).not.toThrow();
    expect(() => assertAwsBootstrapLimits({ environmentId: MAX_ENV, bootstrapNameSuffix: MAX_SUFFIX, accountId: "123456789012", region: "cn-northwest-1" })).not.toThrow();
  });
  it.each(["", "e".repeat(65), "env/1", "env 1", "env\n", "env*", "../x", "env${x}"])("refuses environment id %j with a fixed message", (id) => {
    expect(() => assertEnvironmentIdFits(id)).toThrow(AwsLimitError);
    try { assertEnvironmentIdFits(id); } catch (error) { expect((error as AwsLimitError).limit).toBe("environment_id"); expect((error as Error).message).not.toContain("env/1"); }
  });
  it.each(["a", "-", "-A", `-${"a".repeat(20)}`, "-a/b", " -a"])("refuses suffix %j", (suffix) => {
    expect(() => assertAwsBootstrapLimits({ bootstrapNameSuffix: suffix, accountId: "123456789012" })).toThrow(expect.objectContaining({ limit: "bootstrap_suffix" }));
  });
  it("proves the longest state bucket name stays within S3's 63 characters for every region length", () => {
    expect(stateBucketNameFor("123456789012", "x".repeat(AWS_REGION_NAME_MAX), MAX_SUFFIX).length).toBeLessThanOrEqual(63);
    expect(() => assertAwsBootstrapLimits({ bootstrapNameSuffix: MAX_SUFFIX, accountId: "123456789012", region: "x".repeat(AWS_REGION_NAME_MAX + 4) })).toThrow(expect.objectContaining({ limit: "state_bucket_name" }));
  });
});

describe("role names at the maximum", () => {
  it.each(FAMILIES)("%s base budget plus every reserved suffix is at most 64 characters", (family) => {
    for (const suffix of AWS_ROLE_BOUNDARIES[family].suffixes) expect(roleNameBaseBudget(family) + suffix.length).toBeLessThanOrEqual(64);
  });
  it("accepts and refuses names exactly at the IAM limit", () => {
    expect(() => assertRoleNameFits(`zenith-${"a".repeat(64 - 7 - 5)}-role`, "app")).not.toThrow();
    expect(() => assertRoleNameFits(`zenith-${"a".repeat(64 - 7 - 5 + 1)}-role`, "app")).toThrow(expect.objectContaining({ limit: "role_name" }));
    expect(() => assertRoleNameFits("zenith-x-fn", "build")).toThrow(AwsLimitError);
    expect(() => assertRoleNameFits("other-x-role", "app")).toThrow(AwsLimitError);
    expect(() => assertRoleNameFits("zenith-x/y-role", "app")).toThrow(AwsLimitError);
  });

  it("every role name the real AWS drivers compile for a maximum-length environment fits IAM and its reserved family suffix", () => {
    registerAwsDrivers();
    const graph = expanded("production");
    const ctx = { ...compileContext(graph), namePrefix: environmentName(MAX_ENV) };
    const suffixes = FAMILIES.flatMap((family) => [...AWS_ROLE_BOUNDARIES[family].suffixes]);
    let checked = 0;
    for (const node of graph.nodes) {
      const driver = findDriver("aws", node.nativeType);
      if (!driver?.compile || node.ownership !== "managed") continue;
      const fragment = driver.compile(node, ctx);
      for (const body of Object.values(fragment.resource?.aws_iam_role ?? {})) {
        const name = body.name;
        if (typeof name !== "string") continue;
        checked++;
        expect(name.length, name).toBeLessThanOrEqual(64);
        expect(name.startsWith("zenith-"), name).toBe(true);
        expect(suffixes.some((suffix) => name.endsWith(suffix)), name).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("hosted zone planning", () => {
  it("derives the role's overflow slots from the IAM default quota", () => {
    expect(ROUTE53_OVERFLOW_POLICIES_MAX).toBe(IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA - DEPLOY_ROLE_BASE_MANAGED_POLICIES);
    expect(ROUTE53_ZONES_MAX).toBe(ROUTE53_ZONES_INLINE_MAX + ROUTE53_OVERFLOW_POLICIES_MAX * ROUTE53_ZONES_PER_OVERFLOW_POLICY);
  });

  it.each(AWS_PARTITIONS)("%s: keeps up to the inline maximum inline and chunks the rest in order", (partition) => {
    const zones = sampleLongestRoute53ZoneArns(partition, 65);
    const plan = planRoute53Zones(partition, zones);
    expect(plan.inline).toEqual(zones.slice(0, 20));
    expect(plan.overflow.map((chunk) => chunk.length)).toEqual([40, 5]);
    expect([...plan.inline, ...plan.overflow.flat()]).toEqual(zones);
    expect(planRoute53Zones(partition, zones.slice(0, 20)).overflow).toEqual([]);
    expect(planRoute53Zones(partition, []).inline).toEqual([]);
  });

  it("accepts exactly the maximum and refuses one more, a duplicate, and a foreign-partition ARN", () => {
    const max = sampleLongestRoute53ZoneArns("aws", ROUTE53_ZONES_MAX);
    expect(planRoute53Zones("aws", max).overflow).toHaveLength(ROUTE53_OVERFLOW_POLICIES_MAX);
    expect(() => planRoute53Zones("aws", sampleLongestRoute53ZoneArns("aws", ROUTE53_ZONES_MAX + 1))).toThrow(expect.objectContaining({ limit: "hosted_zone_count" }));
    expect(() => planRoute53Zones("aws", [max[0], max[0]])).toThrow(expect.objectContaining({ limit: "hosted_zone_duplicate" }));
    expect(() => planRoute53Zones("aws", [sampleLongestRoute53ZoneArns("aws-cn", 1)[0]])).toThrow(expect.objectContaining({ limit: "hosted_zone_arn" }));
    expect(() => planRoute53Zones("aws", ["arn:aws:route53:::hostedzone/z-lower"])).toThrow(expect.objectContaining({ limit: "hosted_zone_arn" }));
  });

  it("the inline zones fit DeployEdge and every overflow policy fits IAM in all three partitions at maximum zone ARN length", () => {
    expect(checkBoundarySizes).not.toThrow();
    for (const { partition, logicalId, size } of boundarySizes()) {
      if (logicalId === "DeployEdgePolicy") expect(size, partition).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
    }
    for (const partition of AWS_PARTITIONS) {
      expect(overflowPolicySize(partition), partition).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
      const statement = { Sid: "Route53ChangeRecordsInListedZones", Effect: "Allow", Action: "route53:ChangeResourceRecordSets", Resource: sampleLongestRoute53ZoneArns(partition, ROUTE53_ZONES_PER_OVERFLOW_POLICY) };
      expect(compactPolicySize({ Version: "2012-10-17", Statement: [statement] })).toBe(overflowPolicySize(partition));
    }
  });

  it("the OpenTofu module's literals equal the TypeScript constants", () => {
    const main = fs.readFileSync(path.join(MODULE, "main.tf"), "utf8");
    const variables = fs.readFileSync(path.join(MODULE, "variables.tf"), "utf8");
    expect(main).toContain(`slice(var.route53_hosted_zone_arns, 0, min(length(var.route53_hosted_zone_arns), ${ROUTE53_ZONES_INLINE_MAX}))`);
    expect(main).toContain(`length(var.route53_hosted_zone_arns) > ${ROUTE53_ZONES_INLINE_MAX} ? chunklist(slice(var.route53_hosted_zone_arns, ${ROUTE53_ZONES_INLINE_MAX}, length(var.route53_hosted_zone_arns)), ${ROUTE53_ZONES_PER_OVERFLOW_POLICY}) : []`);
    expect(main).toContain("route53_hosted_zone_arns = local.dns_zones_inline");
    expect(variables).toContain(`length(var.route53_hosted_zone_arns) <= ${ROUTE53_ZONES_MAX}`);
    // The deploy attachment set is the 8 base policies; the overflow attachments are separate resources.
    const attached = /for_each = toset\(\[([^\]]+)\]\)/.exec(main.slice(main.indexOf('resource "aws_iam_role_policy_attachment" "deploy"')));
    expect(attached?.[1].split(",").length).toBe(DEPLOY_ROLE_BASE_MANAGED_POLICIES);
    expect(main).toContain('resource "aws_iam_role_policy_attachment" "dns_overflow"');
    expect(main).toContain('role       = aws_iam_role.deploy.name');
  });
});

describe("preflight role inventory capacity", () => {
  const config = (suffix: string): AwsConnectionConfig => ({
    provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", region: "us-east-1", bootstrapNameSuffix: suffix,
    observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserveRole", deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployRole",
  });
  const roles = (count: number) => Array.from({ length: count }, (_, i) => `arn:aws:iam::123456789012:role/zenith-${String(i).padStart(2, "0")}${"a".repeat(64 - 7 - 2 - 5)}-role`);
  const inventory = (count: number) => ({ workspaceId: "ws-1", environmentId: "env-1", roleArns: roles(count) });

  it.each(["", "-team-a", MAX_SUFFIX])("matches the real session policy exactly for suffix %j: capacity roles pass, one more refuses", (suffix) => {
    const capacity = preflightRoleCapacity("aws", "123456789012", suffix);
    expect(capacity).toBeGreaterThan(0);
    expect(() => awsBootstrapPreflightSessionPolicy(config(suffix), inventory(capacity))).not.toThrow();
    if (capacity < 32) expect(() => awsBootstrapPreflightSessionPolicy(config(suffix), inventory(capacity + 1))).toThrow(SessionPolicyError);
  });
  it("refuses malformed inputs with a fixed code", () => {
    expect(() => preflightRoleCapacity("aws", "1234", "")).toThrow(expect.objectContaining({ limit: "preflight_inventory" }));
    expect(() => preflightRoleCapacity("aws", "123456789012", "bad")).toThrow(AwsLimitError);
  });
});
