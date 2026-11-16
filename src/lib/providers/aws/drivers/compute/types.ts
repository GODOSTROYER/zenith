/** ComputeInstanceSpec remains experimental; FunctionSpec is shared with manifest expansion. */
export type { FunctionSpec } from "@/lib/resources/specs";

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
