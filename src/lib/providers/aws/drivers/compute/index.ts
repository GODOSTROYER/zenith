/**
 * The compute driver group: container workloads (ECS/Fargate), the registry
 * and build pipeline behind them, static sites, and the two experimental
 * kinds (Lambda, EC2).
 *
 * The provider-level `drivers/index.ts` (orchestrator-owned) concatenates the
 * groups and registers them; this file only lists this group's drivers.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { codebuildProjectDriver } from "./codebuild-project";
import { ec2InstanceDriver } from "./ec2-instance";
import { ecrRepositoryDriver } from "./ecr-repository";
import { ecsScheduledTaskDriver } from "./ecs-scheduled-task";
import { ecsServiceDriver } from "./ecs-service";
import { lambdaFunctionDriver } from "./lambda-function";
import { s3StaticSiteDriver } from "./s3-static-site";

export const COMPUTE_DRIVERS: ResourceDriver<AwsSession>[] = [
  ecsServiceDriver,
  ecrRepositoryDriver,
  codebuildProjectDriver,
  ecsScheduledTaskDriver,
  s3StaticSiteDriver,
  lambdaFunctionDriver,
  ec2InstanceDriver,
];

export { codebuildProjectDriver, ec2InstanceDriver, ecrRepositoryDriver, ecsScheduledTaskDriver, ecsServiceDriver, lambdaFunctionDriver, s3StaticSiteDriver };

// helpers the deploy workflow's activities call directly (not capabilities)
export { startBuild, stopBuild, waitForBuild, type BuildOutcome, type StartBuildInput, type StartBuildResult, type WaitOptions } from "./codebuild-builds";
export { buildExpectsImage } from "./codebuild-project";
export { deployImage, setImagePointer, waitForServiceSteady, type SteadyOptions, type SteadyResult } from "./ecs-operations";
export { imagePointerName } from "./ecs-task";
