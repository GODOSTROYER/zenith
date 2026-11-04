import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { firewallRuleDriver } from "./firewall-rule";
import { subnetworkDriver } from "./subnetwork";
import { vpcNetworkDriver } from "./vpc-network";

export const networkDrivers: ResourceDriver<GcpSession>[] = [vpcNetworkDriver, subnetworkDriver, firewallRuleDriver];
