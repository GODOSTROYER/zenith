import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { dnsManagedZoneDriver } from "./dns-managed-zone";
import { dnsRecordSetDriver } from "./dns-record-set";
import { globalHttpLbDriver } from "./global-http-lb";
import { managedSslCertificateDriver } from "./managed-ssl-certificate";

export const edgeDrivers: ResourceDriver<GcpSession>[] = [globalHttpLbDriver, managedSslCertificateDriver, dnsManagedZoneDriver, dnsRecordSetDriver];
