/**
 * AWS partition contract: ARN construction, service principals and DNS suffixes
 * for `aws`, `aws-cn` and `aws-us-gov`.
 *
 * CONTRACT-LEVEL ONLY. Runtime registration (`awsBootstrapContextForConnection`,
 * the connection form, the provider region list) remains commercial-only. These
 * helpers let the bootstrap generator, the compiler's pure rendering and the
 * tests state what a sovereign partition WOULD require without enabling it.
 * Sovereign live acceptance needs a China or GovCloud account and is deferred.
 *
 * The service-principal table follows AWS documentation of service principal
 * names (China uses the `.com.cn` DNS suffix for EC2 only; every other service
 * principal this compiler emits is `<service>.amazonaws.com` in all three
 * partitions). It is a reviewed table, not a live-verified one; a new service
 * must be added here deliberately, never derived from a string at runtime.
 */

export const AWS_PARTITIONS = ["aws", "aws-cn", "aws-us-gov"] as const;
export type AwsPartition = (typeof AWS_PARTITIONS)[number];

export const isAwsPartition = (value: unknown): value is AwsPartition =>
  typeof value === "string" && (AWS_PARTITIONS as readonly string[]).includes(value);

/** `aws_partition.dns_suffix`: the suffix of regional service endpoints and OIDC issuers. */
export const AWS_PARTITION_DNS_SUFFIX: Readonly<Record<AwsPartition, string>> = Object.freeze({
  aws: "amazonaws.com",
  "aws-cn": "amazonaws.com.cn",
  "aws-us-gov": "amazonaws.com",
});

/** Services whose IAM service principal is NOT `<service>.amazonaws.com` in a partition. */
const PRINCIPAL_SUFFIX_EXCEPTIONS: Readonly<Record<AwsPartition, Readonly<Record<string, string>>>> = Object.freeze({
  aws: Object.freeze({}),
  "aws-cn": Object.freeze({ ec2: "amazonaws.com.cn" }),
  "aws-us-gov": Object.freeze({}),
});

/** Every service principal the compiler may render; anything else is refused. */
export const AWS_SERVICE_PRINCIPAL_SERVICES = Object.freeze([
  "codebuild", "ec2", "ecs-tasks", "eks", "events", "lambda", "vpc-flow-logs", "cloudfront", "sns",
] as const);
export type AwsPrincipalService = (typeof AWS_SERVICE_PRINCIPAL_SERVICES)[number];

export class AwsPartitionError extends Error {
  readonly code = "aws_partition_invalid";
  constructor(message: string) {
    super(message);
    this.name = "AwsPartitionError";
  }
}

const SERVICE = /^[a-z0-9-]{1,64}$/;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const RESOURCE = /^[\x21-\x7e]{1,1024}$/;

/** Strict region to partition mapping. Isolated partitions (`us-iso*`) are not supported and refuse. */
export function awsPartitionForRegion(region: unknown): AwsPartition {
  if (typeof region !== "string" || !REGION.test(region)) throw new AwsPartitionError("AWS region is invalid.");
  if (region.startsWith("us-iso")) throw new AwsPartitionError("Isolated AWS partitions are not supported.");
  if (region.startsWith("cn-")) return "aws-cn";
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  return "aws";
}

/** The IAM service principal for a known service in a partition, e.g. `ec2.amazonaws.com.cn`. */
export function awsServicePrincipal(partition: AwsPartition, service: string): string {
  if (!isAwsPartition(partition)) throw new AwsPartitionError("AWS partition is invalid.");
  if (!SERVICE.test(service) || !(AWS_SERVICE_PRINCIPAL_SERVICES as readonly string[]).includes(service)) {
    throw new AwsPartitionError("AWS service principal is not in the reviewed table.");
  }
  return `${service}.${PRINCIPAL_SUFFIX_EXCEPTIONS[partition][service] ?? "amazonaws.com"}`;
}

/** Commercial form (`ecs-tasks.amazonaws.com`) to the service name, or undefined when it is not one. */
export function serviceOfCommercialPrincipal(principal: string): AwsPrincipalService | undefined {
  const match = /^([a-z0-9-]+)\.amazonaws\.com$/.exec(principal);
  return match && (AWS_SERVICE_PRINCIPAL_SERVICES as readonly string[]).includes(match[1]) ? (match[1] as AwsPrincipalService) : undefined;
}

/** Re-render a commercial principal for another partition; unknown principals refuse. */
export function principalForPartition(partition: AwsPartition, commercialPrincipal: string): string {
  const service = serviceOfCommercialPrincipal(commercialPrincipal);
  if (!service) throw new AwsPartitionError("AWS service principal is not in the reviewed table.");
  return awsServicePrincipal(partition, service);
}

/** `arn:<partition>:<service>:<region>:<account>:<resource>` with each segment validated. */
export function awsArn(partition: AwsPartition, service: string, region: string, accountId: string, resource: string): string {
  if (!isAwsPartition(partition)) throw new AwsPartitionError("AWS partition is invalid.");
  if (!SERVICE.test(service)) throw new AwsPartitionError("AWS service is invalid.");
  if (region !== "" && !REGION.test(region)) throw new AwsPartitionError("AWS region is invalid.");
  if (accountId !== "" && !ACCOUNT.test(accountId)) throw new AwsPartitionError("AWS account id is invalid.");
  if (!RESOURCE.test(resource)) throw new AwsPartitionError("AWS resource is invalid.");
  return `arn:${partition}:${service}:${region}:${accountId}:${resource}`;
}

export const iamRoleArn = (partition: AwsPartition, accountId: string, name: string, path = ""): string => {
  if (path !== "" && !/^(?:[A-Za-z0-9+=,.@_-]+\/)+$/.test(path)) throw new AwsPartitionError("IAM path is invalid.");
  return awsArn(partition, "iam", "", accountId, `role/${path}${name}`);
};

export const iamPolicyArn = (partition: AwsPartition, accountId: string, name: string): string =>
  awsArn(partition, "iam", "", accountId, `policy/${name}`);

export const kmsKeyArn = (partition: AwsPartition, region: string, accountId: string, keyId: string): string => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(keyId)) throw new AwsPartitionError("KMS key id is invalid.");
  return awsArn(partition, "kms", region, accountId, `key/${keyId}`);
};

export const s3BucketArn = (partition: AwsPartition, bucket: string): string => {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new AwsPartitionError("S3 bucket name is invalid.");
  return `arn:${partition}:s3:::${bucket}`;
};

export const route53ZoneArn = (partition: AwsPartition, zoneId: string): string => {
  if (!/^Z[A-Z0-9]{1,31}$/.test(zoneId)) throw new AwsPartitionError("Route 53 hosted zone id is invalid.");
  return `arn:${partition}:route53:::hostedzone/${zoneId}`;
};

/** A parsed ARN's partition, or undefined when the value is not a well formed ARN of a supported partition. */
export function partitionOfArn(arn: unknown): AwsPartition | undefined {
  if (typeof arn !== "string" || arn.length > 2048) return undefined;
  const match = /^arn:(aws|aws-cn|aws-us-gov):[a-z0-9-]+:/.exec(arn);
  return match ? (match[1] as AwsPartition) : undefined;
}

/** Every ARN must be in `partition`; one foreign or malformed ARN refuses the whole set. */
export function assertSamePartition(partition: AwsPartition, arns: readonly unknown[]): void {
  for (const arn of arns) {
    if (partitionOfArn(arn) !== partition) throw new AwsPartitionError("AWS identifiers span more than one partition.");
  }
}
