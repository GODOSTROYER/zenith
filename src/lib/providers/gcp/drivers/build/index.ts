import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { artifactRegistryRepositoryDriver } from "./artifact-registry-repository";
import { cloudBuildTriggerDriver } from "./cloud-build-trigger";

export const buildDrivers: ResourceDriver<GcpSession>[] = [artifactRegistryRepositoryDriver, cloudBuildTriggerDriver];
export { getBuild, startBuild, validateBuildInput, type BuildResult, type BuildStatus, type StartBuildInput } from "./build-api";
