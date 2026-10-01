import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { containerAppDriver } from "@/lib/providers/azure/drivers/compute/container-app";
import { containerAppJobDriver } from "@/lib/providers/azure/drivers/compute/container-app-job";
import { loadBalancerDriver } from "@/lib/providers/azure/drivers/compute/load-balancer";

/** Compute group: Container Apps, jobs and the ingress that fronts them. */
export const computeDrivers: ResourceDriver<AzureSession>[] = [containerAppDriver, containerAppJobDriver, loadBalancerDriver];
