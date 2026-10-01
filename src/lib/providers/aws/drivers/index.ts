/**
 * One coherent AWS provider. Registration is explicit and idempotent; every
 * claim remains contract evidence until exercised against a live account.
 */
import type { AwsSession } from "@/lib/credentials/types";
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { networkDrivers } from "./network";
import { COMPUTE_DRIVERS } from "./compute";
import { awsDataDrivers } from "./data";

export const awsDrivers: ResourceDriver<AwsSession>[] = [...networkDrivers, ...COMPUTE_DRIVERS, ...awsDataDrivers];

/** Explicit gaps in the native-type vocabulary; never silently fake a driver. */
export const NOT_YET_IMPLEMENTED = new Set([
  "aws:sns_topic", // Pub/sub lifecycle and subscription drivers have not been implemented.
  "aws:eks_cluster", // Cluster lifecycle belongs to the pending Kubernetes-on-AWS workstream.
  "aws:ebs_volume", // Standalone persistent-volume lifecycle has not been implemented.
]);

export function registerAwsDrivers(): void {
  for (const driver of awsDrivers) registerDriver(driver as unknown as ResourceDriver);
}
