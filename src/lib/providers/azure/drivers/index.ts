/**
 * All Azure resource drivers and their idempotent registration.
 *
 * `registerAzureDrivers()` registers every driver under `("azure", nativeType)`
 * exactly as `src/lib/resources/native-types.ts` names them. Registering twice
 * is harmless (the registry replaces the entry with the same driver).
 *
 * Not registered, because the native-type table names them but no driver
 * exists: `azure:mysql_flexible_server`, `azure:virtual_machine`,
 * `azure:function_app`, `azure:static_web_app`, `azure:aks_cluster`,
 * `azure:managed_disk`. Nodes of those kinds stay `unsupported` until built.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { registerDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { computeDrivers } from "@/lib/providers/azure/drivers/compute";
import { dataDrivers } from "@/lib/providers/azure/drivers/data";
import { dnsDrivers } from "@/lib/providers/azure/drivers/dns";
import { identityDrivers } from "@/lib/providers/azure/drivers/identity";
import { networkDrivers } from "@/lib/providers/azure/drivers/network";
import { platformDrivers } from "@/lib/providers/azure/drivers/platform";

export const AZURE_DRIVERS: readonly ResourceDriver<AzureSession>[] = [
  ...networkDrivers,
  ...computeDrivers,
  ...dataDrivers,
  ...identityDrivers,
  ...platformDrivers,
  ...dnsDrivers,
];

export function registerAzureDrivers(): void {
  for (const d of AZURE_DRIVERS) registerDriver(d as unknown as ResourceDriver);
}
