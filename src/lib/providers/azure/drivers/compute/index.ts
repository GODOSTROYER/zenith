import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { containerAppDriver } from "@/lib/providers/azure/drivers/compute/container-app";
import { containerAppJobDriver } from "@/lib/providers/azure/drivers/compute/container-app-job";
import { loadBalancerDriver } from "@/lib/providers/azure/drivers/compute/load-balancer";
import { virtualMachineDriver } from "@/lib/providers/azure/drivers/compute/virtual-machine";
import { functionAppDriver } from "@/lib/providers/azure/drivers/compute/function-app";
import { staticWebAppDriver } from "@/lib/providers/azure/drivers/compute/static-web-app";
import { aksClusterDriver } from "@/lib/providers/azure/drivers/compute/aks-cluster";

/** Compute group: Container Apps, jobs and the ingress that fronts them. */
export const computeDrivers: ResourceDriver<AzureSession>[] = [containerAppDriver, containerAppJobDriver, loadBalancerDriver, virtualMachineDriver, functionAppDriver, staticWebAppDriver, aksClusterDriver];
