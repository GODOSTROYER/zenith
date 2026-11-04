import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { dnsRecordDriver } from "@/lib/providers/azure/drivers/dns/dns-record";
import { dnsZoneDriver } from "@/lib/providers/azure/drivers/dns/dns-zone";
import { managedCertificateDriver } from "@/lib/providers/azure/drivers/dns/managed-certificate";

/** DNS group: referenced zones, record sets, managed certificates. */
export const dnsDrivers: ResourceDriver<AzureSession>[] = [dnsZoneDriver, dnsRecordDriver, managedCertificateDriver];
