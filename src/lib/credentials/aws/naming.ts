/**
 * AWS naming and tagging conventions shared by the broker's session policies,
 * the customer bootstrap templates (`deploy/aws`) and — by agreement — the
 * OpenTofu compiler and AWS drivers.
 *
 *   - every resource Zenith creates is named `zenith-<environmentId>-…` (or
 *     lives under a `/zenith/<environmentId>/` path for log groups)
 *   - every resource Zenith creates is tagged `zenith:managed=true` and
 *     `zenith:environment=<environmentId>`
 *
 * The deploy role and the per-capability session policies both key off these,
 * so a resource that breaks the convention is simply outside Zenith's reach —
 * which is the safe failure.
 *
 * Caveat (documented, not fixable in IAM): name patterns end in a `-` or `/`
 * delimiter, so environment ids that are hyphen-delimited prefixes of one
 * another (`prod` and `prod-eu`) overlap in name-based patterns. Fixed-width
 * ids (UUIDs) cannot overlap. The tag condition (`zenith:environment`, exact
 * match) is the precise boundary where the service supports it.
 */

export const TAG_MANAGED = "zenith:managed";
export const TAG_ENVIRONMENT = "zenith:environment";
export const TAG_WORKSPACE = "zenith:workspace";
export const TAG_OPERATION = "zenith:operation";
export const TAG_CAPABILITY = "zenith:capability";

export const NAME_PREFIX = "zenith-";

/**
 * Reserved for CodeBuild service roles, never application identities. The
 * driver appends this suffix AFTER cloudName truncates/hashes the base. The
 * bootstrap policy generator verifies its PrincipalArn against this pattern.
 */
export const BUILD_ROLE_SUFFIX = "-build";
export const BUILD_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${BUILD_ROLE_SUFFIX}`;

/** EventBridge invocation and EC2 agent roles reserve these after truncation too. */
export const EVENTS_ROLE_SUFFIX = "-events";
export const EVENTS_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${EVENTS_ROLE_SUFFIX}`;
export const EC2_ROLE_SUFFIX = "-ec2";
export const EC2_ROLE_NAME_PATTERN = `${NAME_PREFIX}*${EC2_ROLE_SUFFIX}`;

/** Bootstrap owns these immutable policies. Drivers select only from this map. */
export const AWS_ROLE_BOUNDARIES = {
  app: { logicalId: "AppBoundary", policyName: "ZenithAppBoundary", template: "app-boundary", suffixes: ["-role", "-exec", "-fn", "-flow"] },
  build: { logicalId: "BuildBoundary", policyName: "ZenithBuildBoundary", template: "build-boundary", suffixes: [BUILD_ROLE_SUFFIX] },
  machine: { logicalId: "MachineBoundary", policyName: "ZenithMachineBoundary", template: "machine-boundary", suffixes: [EC2_ROLE_SUFFIX] },
  scheduler: { logicalId: "SchedulerBoundary", policyName: "ZenithSchedulerBoundary", template: "scheduler-boundary", suffixes: [EVENTS_ROLE_SUFFIX] },
  eksCluster: { logicalId: "EksClusterBoundary", policyName: "ZenithEksClusterBoundary", template: "eks-cluster-boundary", suffixes: ["-cluster"] },
  eksNode: { logicalId: "EksNodeBoundary", policyName: "ZenithEksNodeBoundary", template: "eks-node-boundary", suffixes: ["-nodes"] },
} as const;
export type AwsRoleFamily = keyof typeof AWS_ROLE_BOUNDARIES;
export const roleFamilyPatterns = (family: AwsRoleFamily): string[] => AWS_ROLE_BOUNDARIES[family].suffixes.map((suffix) => `${NAME_PREFIX}*${suffix}`);
export const BOOTSTRAP_NAME_SUFFIX_PATTERN = /^(-[a-z0-9-]{1,19})?$/;
export const isBootstrapNameSuffix = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 20 && BOOTSTRAP_NAME_SUFFIX_PATTERN.exec(value)?.[0] === value;

export interface AwsBootstrapContext {
  readonly accountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly bootstrapNameSuffix: string;
}

/** Current connection registration regions; sovereign runtime remains unsupported. */
export const AWS_CONNECTION_REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-2"] as const;
export const isSupportedAwsConnectionRegion = (value: unknown): value is string =>
  typeof value === "string" && (AWS_CONNECTION_REGIONS as readonly string[]).includes(value);

/** State encryption belongs to the connection's backend region, not a workload region. */
export function isAwsStateKmsArn(value: unknown, accountId: string, backendRegion: string): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  const match = /^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/[A-Za-z0-9-]+$/.exec(value);
  return !!match && match[0] === value && match[1] === backendRegion && match[2] === accountId;
}

/** Pure rendering supports three partitions; this does not enable runtime registration. */
export function resolveAwsRoleBoundaries(context: AwsBootstrapContext): Readonly<Record<AwsRoleFamily, string>> {
  if (typeof context.accountId !== "string" || context.accountId.length !== 12 || !/^\d{12}$/.test(context.accountId) || !["aws", "aws-cn", "aws-us-gov"].includes(context.partition) || !isBootstrapNameSuffix(context.bootstrapNameSuffix)) {
    throw new Error("AWS bootstrap identifiers are invalid.");
  }
  return Object.freeze(Object.fromEntries((Object.keys(AWS_ROLE_BOUNDARIES) as AwsRoleFamily[]).map((family) =>
    [family, awsBoundaryArn(family, context.partition, context.accountId, context.bootstrapNameSuffix)])) as Record<AwsRoleFamily, string>);
}

export const awsBoundaryArn = (family: AwsRoleFamily, partition: string, accountId: string, suffix = ""): string => {
  if (!Object.hasOwn(AWS_ROLE_BOUNDARIES, family)) throw new Error("AWS role family is invalid.");
  if (!isBootstrapNameSuffix(suffix)) throw new Error("AWS bootstrap name suffix is invalid.");
  return `arn:${partition}:iam::${accountId}:policy/${AWS_ROLE_BOUNDARIES[family].policyName}${suffix}`;
};

/** Choose only a canonical family, never a graph-supplied policy or path. */
export const trustedAwsBoundaryArn = (context: AwsBootstrapContext | undefined, family: AwsRoleFamily): string | undefined =>
  context ? resolveAwsRoleBoundaries(context)[family] : undefined;

/** Runtime currently supports commercial AWS only; roles and region must agree. */
export function awsBootstrapContextForConnection(config: import("../types").ConnectionConfig, region = config.provider === "aws" ? config.region : ""): AwsBootstrapContext {
  if (config.provider !== "aws") throw new Error("AWS requires an AWS connection.");
  if (typeof config.observeRoleArn !== "string" || typeof config.deployRoleArn !== "string" || config.observeRoleArn.length > 2048 || config.deployRoleArn.length > 2048) throw new Error("AWS connection role identifiers are invalid.");
  const commercialRole = /^arn:aws:iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]{1,64}$/;
  const observe = commercialRole.exec(config.observeRoleArn);
  const deploy = commercialRole.exec(config.deployRoleArn);
  if (!observe || !deploy || observe[0] !== config.observeRoleArn || deploy[0] !== config.deployRoleArn || observe[1] !== config.accountId || deploy[1] !== config.accountId || !isSupportedAwsConnectionRegion(config.region) || !isSupportedAwsConnectionRegion(region)) {
    throw new Error("AWS connection roles, account and supported partition must agree.");
  }
  if (config.codeBuildRoleArn !== undefined) {
    const build = typeof config.codeBuildRoleArn === "string" && config.codeBuildRoleArn.length <= 2048 ? commercialRole.exec(config.codeBuildRoleArn) : null;
    if (!build || build[0] !== config.codeBuildRoleArn || build[1] !== config.accountId) throw new Error("AWS build role must match the connection account and partition.");
  }
  if (config.stateKmsKeyArn !== undefined && !isAwsStateKmsArn(config.stateKmsKeyArn, config.accountId, config.region)) throw new Error("AWS state encryption key must match the connection account, partition and backend region.");
  const context: AwsBootstrapContext = Object.freeze({ accountId: config.accountId, partition: "aws", bootstrapNameSuffix: config.bootstrapNameSuffix === undefined ? "" : config.bootstrapNameSuffix });
  resolveAwsRoleBoundaries(context);
  return context;
}

/** Environment ids embedded in ARN patterns: no wildcards, no policy variables, no separators. */
export const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const environmentName = (environmentId: string): string => `${NAME_PREFIX}${environmentId}`;
