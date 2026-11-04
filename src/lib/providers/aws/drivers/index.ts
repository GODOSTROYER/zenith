/**
 * One coherent AWS provider. Registration is explicit and idempotent; every
 * claim remains contract evidence until exercised against a live account.
 */
import type { AwsSession } from "@/lib/credentials/types";
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { networkDrivers } from "./network";
import { COMPUTE_DRIVERS } from "./compute";
import { awsDataDrivers } from "./data";
import { registerNativeType } from "@/lib/resources/native-registry";
import { SNS_TOPIC_SCHEMA, snsTopicDriver } from "./messaging/sns-topic";
import { EBS_VOLUME_SCHEMA, ebsVolumeDriver } from "./storage/ebs-volume";
import { EKS_CLUSTER_SCHEMA, eksClusterDriver } from "./eks/eks-cluster";

export const awsDrivers: ResourceDriver<AwsSession>[] = [...networkDrivers, ...COMPUTE_DRIVERS, ...awsDataDrivers, snsTopicDriver, ebsVolumeDriver, eksClusterDriver];

/** Explicit gaps in the native-type vocabulary; never silently fake a driver. */
export const NOT_YET_IMPLEMENTED = new Set<string>();

export function registerAwsDrivers(): void {
  registerNativeType("aws", "aws:sns_topic", SNS_TOPIC_SCHEMA, "KMS-encrypted SNS topic and SQS subscriptions");
  registerNativeType("aws", "aws:ebs_volume", EBS_VOLUME_SCHEMA, "Encrypted standalone gp3 EBS volume");
  registerNativeType("aws", "aws:eks_cluster", EKS_CLUSTER_SCHEMA, "Private EKS cluster and managed node group with EKS SDK reads");
  for (const driver of awsDrivers) registerDriver(driver as unknown as ResourceDriver);
}
