import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { certificateDriver } from "./certificate";
import { dnsRrsetDriver, dnsZoneDriver } from "./dns";
import { loadBalancerDriver } from "./load-balancer";

/** Load balancer, certificate lookup, DNS zone lookup and record sets. */
export const edgeDrivers: ResourceDriver<OciSession>[] = [loadBalancerDriver, certificateDriver, dnsZoneDriver, dnsRrsetDriver];
