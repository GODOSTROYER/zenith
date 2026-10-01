import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { firewallDriver } from "@/lib/providers/azure/drivers/network/firewall";
import { networkDriver } from "@/lib/providers/azure/drivers/network/network";
import { subnetDriver } from "@/lib/providers/azure/drivers/network/subnet";

/** Network group: the landing zone, portable subnets, NSG rules. */
export const networkDrivers: ResourceDriver<AzureSession>[] = [networkDriver, subnetDriver, firewallDriver];
