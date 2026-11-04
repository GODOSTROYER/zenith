import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { acrTaskDriver } from "@/lib/providers/azure/drivers/platform/acr-task";
import { containerRegistryDriver } from "@/lib/providers/azure/drivers/platform/container-registry";
import { logAnalyticsDriver } from "@/lib/providers/azure/drivers/platform/log-analytics";

/** Platform group: logs, registry, builds. */
export const platformDrivers: ResourceDriver<AzureSession>[] = [logAnalyticsDriver, containerRegistryDriver, acrTaskDriver];
