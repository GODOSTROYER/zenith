import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { securityRuleDriver } from "./security-rule";
import { subnetDriver } from "./subnet";
import { vcnDriver } from "./vcn";

/** VCN + gateways + route tables, regional subnets, and NSG-rule firewalls. */
export const networkDrivers: ResourceDriver<OciSession>[] = [vcnDriver, subnetDriver, securityRuleDriver];
