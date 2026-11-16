/**
 * Explicit AWS identifier and count limits for the bootstrap contract.
 *
 * Everything here refuses with a fixed `AwsLimitError` code and a fixed
 * message; input values are never echoed. The same constants back the
 * bootstrap generator, the OpenTofu module's variable validation (pinned by a
 * test that reads `main.tf`/`variables.tf`), the compiler's pre-flight check
 * and the preflight session-policy capacity.
 *
 * "Zones" here means Route 53 hosted zones that Zenith may write records in.
 * They are the only per-connection list that grows an IAM policy.
 */
import { BOOTSTRAP_NAME_SUFFIX_PATTERN, isBootstrapNameSuffix } from "../../aws-bootstrap-input";
import { type AwsPartition, isAwsPartition, route53ZoneArn } from "./partition";
import { IAM_MANAGED_POLICY_MAX_CHARS, IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA } from "./policy-budget";
import { SESSION_POLICY_MAX_CHARS } from "./policy";
import { AWS_ROLE_BOUNDARIES, ENVIRONMENT_ID_PATTERN, NAME_PREFIX, type AwsRoleFamily } from "./naming";

export const IAM_ROLE_NAME_MAX = 64;
export const IAM_POLICY_NAME_MAX = 128;
export const S3_BUCKET_NAME_MAX = 63;
/** Longest AWS region name in any supported partition (`ap-southeast-N`, `cn-northwest-1`). */
export const AWS_REGION_NAME_MAX = 14;
export const ENVIRONMENT_ID_MAX = 64;

/** Managed policies already attached to the deploy role by the bootstrap (observe + seven deploy). */
export const DEPLOY_ROLE_BASE_MANAGED_POLICIES = 8;
/** Zones carried inside the DeployEdge policy itself; sized so the policy stays within budget. */
export const ROUTE53_ZONES_INLINE_MAX = 20;
/** Zones per additional overflow policy, sized with the longest hosted-zone ARN. */
export const ROUTE53_ZONES_PER_OVERFLOW_POLICY = 40;
/** The deploy role's remaining managed-policy slots under the default quota. */
export const ROUTE53_OVERFLOW_POLICIES_MAX = IAM_ROLE_MANAGED_POLICIES_DEFAULT_QUOTA - DEPLOY_ROLE_BASE_MANAGED_POLICIES;
export const ROUTE53_ZONES_MAX = ROUTE53_ZONES_INLINE_MAX + ROUTE53_OVERFLOW_POLICIES_MAX * ROUTE53_ZONES_PER_OVERFLOW_POLICY;

export type AwsLimitCode =
  | "environment_id" | "bootstrap_suffix" | "role_name" | "policy_name" | "state_bucket_name"
  | "hosted_zone_count" | "hosted_zone_arn" | "hosted_zone_duplicate" | "preflight_inventory";

const MESSAGES: Readonly<Record<AwsLimitCode, string>> = Object.freeze({
  environment_id: "The environment id is not a valid AWS name component (1 to 64 letters, digits, underscore or hyphen).",
  bootstrap_suffix: "The bootstrap name suffix is not valid (empty, or a dash followed by 1 to 19 lowercase letters, digits or dashes).",
  role_name: "A generated IAM role name does not fit IAM's 64-character limit with its reserved family suffix.",
  policy_name: "A bootstrap policy name with this suffix does not fit IAM's 128-character limit.",
  state_bucket_name: "The state bucket name with this suffix does not fit S3's 63-character limit.",
  hosted_zone_count: `At most ${ROUTE53_ZONES_MAX} hosted zones can be granted: ${ROUTE53_ZONES_INLINE_MAX} in DeployEdge plus ${ROUTE53_OVERFLOW_POLICIES_MAX} overflow policies of ${ROUTE53_ZONES_PER_OVERFLOW_POLICY}, within IAM's managed policy quota.`,
  hosted_zone_arn: "A hosted zone entry is not a valid hosted zone ARN for this partition.",
  hosted_zone_duplicate: "Hosted zone ARNs must be unique.",
  preflight_inventory: "The role inventory is too large for the 2,048-character preflight session policy.",
});

export class AwsLimitError extends Error {
  readonly code = "aws_limit_exceeded";
  constructor(readonly limit: AwsLimitCode) {
    super(MESSAGES[limit]);
    this.name = "AwsLimitError";
  }
}

export function assertEnvironmentIdFits(environmentId: unknown): asserts environmentId is string {
  if (typeof environmentId !== "string" || environmentId.length > ENVIRONMENT_ID_MAX || !ENVIRONMENT_ID_PATTERN.test(environmentId)) throw new AwsLimitError("environment_id");
}

/** Longest base a generated role name may have for a family: the 64-character budget minus the reserved suffix. */
export function roleNameBaseBudget(family: AwsRoleFamily): number {
  const longest = Math.max(...AWS_ROLE_BOUNDARIES[family].suffixes.map((suffix) => suffix.length));
  return IAM_ROLE_NAME_MAX - longest;
}

/** A role name the compiler produced must fit IAM, start with `zenith-` and end in a reserved family suffix. */
export function assertRoleNameFits(name: unknown, family: AwsRoleFamily): asserts name is string {
  if (typeof name !== "string" || name.length > IAM_ROLE_NAME_MAX || !/^[\w+=,.@-]+$/.test(name) || !name.startsWith(NAME_PREFIX)
    || !AWS_ROLE_BOUNDARIES[family].suffixes.some((suffix) => name.endsWith(suffix))) throw new AwsLimitError("role_name");
}

/** Policy names the bootstrap creates, by base name; the suffix is appended by the stack. */
export const BOOTSTRAP_POLICY_BASE_NAMES: readonly string[] = Object.freeze([
  ...Object.values(AWS_ROLE_BOUNDARIES).map((family) => family.policyName),
  "ZenithWorkloadBoundary", "ZenithObservePolicy", "ZenithDeployNetwork", "ZenithDeployBalancing", "ZenithDeployCompute",
  "ZenithDeployData", "ZenithDeployEdge", "ZenithDeployState", "ZenithDeployIam", "ZenithDeployEdgeDns99",
  "ZenithObserveRole", "ZenithDeployRole", "ZenithSecretWriterRole",
]);

/** `zenith-state-<account>-<region><suffix>`, as the bootstrap names the state bucket. */
export const stateBucketNameFor = (accountId: string, region: string, suffix: string): string => `zenith-state-${accountId}-${region}${suffix}`;

export interface AwsBootstrapLimitInput {
  readonly environmentId?: string;
  readonly bootstrapNameSuffix: string;
  readonly accountId: string;
  readonly region?: string;
}

/**
 * The suffix and environment must fit every name the bootstrap and compiler derive from them.
 * Longest-region is assumed when no region is given.
 */
export function assertAwsBootstrapLimits(input: AwsBootstrapLimitInput): void {
  if (!isBootstrapNameSuffix(input.bootstrapNameSuffix) || !BOOTSTRAP_NAME_SUFFIX_PATTERN.test(input.bootstrapNameSuffix)) throw new AwsLimitError("bootstrap_suffix");
  if (input.environmentId !== undefined) assertEnvironmentIdFits(input.environmentId);
  for (const base of BOOTSTRAP_POLICY_BASE_NAMES) {
    const limit = /Role$/.test(base) ? IAM_ROLE_NAME_MAX : IAM_POLICY_NAME_MAX;
    if (base.length + input.bootstrapNameSuffix.length > limit) throw new AwsLimitError("policy_name");
  }
  if (!/^\d{12}$/.test(input.accountId)) throw new AwsLimitError("state_bucket_name");
  const region = input.region ?? "x".repeat(AWS_REGION_NAME_MAX);
  if (stateBucketNameFor(input.accountId, region, input.bootstrapNameSuffix).length > S3_BUCKET_NAME_MAX) throw new AwsLimitError("state_bucket_name");
}

export interface Route53ZonePlan {
  /** Zones rendered into the DeployEdge policy. */
  readonly inline: readonly string[];
  /** Overflow policies, each attached to the deploy role as its own managed policy. */
  readonly overflow: readonly (readonly string[])[];
}

/**
 * Reference partitioning of the hosted zone list. The OpenTofu module's HCL
 * (`slice` and `chunklist` with the same three constants) must agree; a test pins
 * the literals. Order is preserved; duplicates and foreign-partition ARNs refuse.
 */
export function planRoute53Zones(partition: AwsPartition, zoneArns: readonly string[]): Route53ZonePlan {
  if (!isAwsPartition(partition)) throw new AwsLimitError("hosted_zone_arn");
  if (zoneArns.length > ROUTE53_ZONES_MAX) throw new AwsLimitError("hosted_zone_count");
  const pattern = new RegExp(`^arn:${partition}:route53:::hostedzone/Z[A-Z0-9]{1,31}$`);
  for (const arn of zoneArns) if (typeof arn !== "string" || !pattern.test(arn)) throw new AwsLimitError("hosted_zone_arn");
  if (new Set(zoneArns).size !== zoneArns.length) throw new AwsLimitError("hosted_zone_duplicate");
  const inline = zoneArns.slice(0, ROUTE53_ZONES_INLINE_MAX);
  const rest = zoneArns.slice(ROUTE53_ZONES_INLINE_MAX);
  const overflow: string[][] = [];
  for (let i = 0; i < rest.length; i += ROUTE53_ZONES_PER_OVERFLOW_POLICY) overflow.push(rest.slice(i, i + ROUTE53_ZONES_PER_OVERFLOW_POLICY));
  return Object.freeze({ inline: Object.freeze(inline), overflow: Object.freeze(overflow.map((chunk) => Object.freeze(chunk))) });
}

/** The longest hosted zone ARN in a partition (zone ids are at most 32 characters including the leading Z). */
export const longestRoute53ZoneArn = (partition: AwsPartition): string => route53ZoneArn(partition, `Z${"A".repeat(31)}`);

/** `count` distinct, maximum-length hosted zone ARNs, for sizing and tests. */
export const sampleLongestRoute53ZoneArns = (partition: AwsPartition, count: number): string[] =>
  Array.from({ length: count }, (_, i) => route53ZoneArn(partition, `Z${String(i).padStart(31, "0")}`));

/**
 * How many role ARNs the preflight inventory can carry before the 2,048-character
 * session policy refuses, for the longest possible role names. Used to refuse
 * oversized inventories with a precise code instead of an opaque STS failure.
 */
export function preflightRoleCapacity(partition: AwsPartition, accountId: string, bootstrapNameSuffix: string): number {
  if (!isAwsPartition(partition) || !/^\d{12}$/.test(accountId) || !isBootstrapNameSuffix(bootstrapNameSuffix)) throw new AwsLimitError("preflight_inventory");
  const policyArns = [...Object.values(AWS_ROLE_BOUNDARIES).map((family) => family.policyName), "ZenithWorkloadBoundary"]
    .map((name) => `arn:${partition}:iam::${accountId}:policy/${name}${bootstrapNameSuffix}`);
  const skeleton = (roles: string[]): number => JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource: policyArns },
      ...(roles.length ? [{ Effect: "Allow", Action: "iam:GetRole", Resource: roles }] : [])],
  }).length;
  const roleArn = (i: number): string => `arn:${partition}:iam::${accountId}:role/zenith-${String(i).padStart(2, "0")}${"a".repeat(IAM_ROLE_NAME_MAX - 7 - 2 - 5)}-role`;
  let count = 0;
  while (count < 32 && skeleton(Array.from({ length: count + 1 }, (_, i) => roleArn(i))) <= SESSION_POLICY_MAX_CHARS) count++;
  return count;
}

/** The IAM managed policy ceiling re-exported for callers that only import limits. */
export const MANAGED_POLICY_MAX_CHARS = IAM_MANAGED_POLICY_MAX_CHARS;
