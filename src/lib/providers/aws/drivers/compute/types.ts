/**
 * Types private to the compute driver group.
 *
 * `FunctionSpec` and `ComputeInstanceSpec` are NOT in `@/lib/resources/specs`:
 * expansion never produces `function` or `compute_instance` nodes today
 * (specs.ts says so), so these describe what the two experimental drivers
 * read from a hand-built graph. If expansion starts producing those kinds,
 * promote these into specs.ts (additive) and delete them here.
 */
import type { EnvEntry } from "@/lib/resources/specs";

export interface FunctionSpec {
  /** Lambda runtime identifier, e.g. `nodejs22.x` */
  runtime: string;
  /** e.g. `index.handler` */
  handler: string;
  memoryMb?: number;
  timeoutSec?: number;
  architecture?: "x86_64" | "arm64";
  /** the deployment package, a zip object already in S3 */
  artifact: { type: "s3"; bucket: string; key: string; version?: string };
  /** plain values only: Lambda has no `valueFrom`, so a `secretRef` is rejected at compile time */
  env?: EnvEntry[];
}

export interface ComputeInstanceSpec {
  /** EC2 instance type, default `t3.small` */
  instanceType?: string;
  /** root volume size in GiB, default 20 */
  rootVolumeGb?: number;
  /** architecture of the AL2023 image; must agree with `instanceType` (Graviton types are `arm64`) */
  architecture?: "x86_64" | "arm64";
}

/** Driver ids, one constant each so tests and the registry agree. */
export const DRIVER_IDS = {
  ecsService: "aws.ecs_service@1",
  ecrRepository: "aws.ecr_repository@1",
  codebuildProject: "aws.codebuild_project@1",
  ecsScheduledTask: "aws.ecs_scheduled_task@1",
  s3StaticSite: "aws.s3_static_site@1",
  lambdaFunction: "aws.lambda_function@1",
  ec2Instance: "aws.ec2_instance@1",
} as const;
