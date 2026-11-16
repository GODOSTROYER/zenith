/**
 * The OCI driver set and its registration.
 *
 * Every driver is a `ResourceDriver<OciSession>` registered under
 * `("oci", <native type from src/lib/resources/native-types.ts>)`. The
 * orchestrator may replace this file at integration (DRIVER-CONVENTIONS); it
 * is kept here so the provider is usable and testable on its own.
 *
 * Coverage (see each driver's module comment for the honest limits):
 *   full web path   oci:vcn, oci:subnet, oci:security_list_rule (NSG rules),
 *                   oci:load_balancer, oci:certificate (lookup only),
 *                   oci:dns_zone (lookup), oci:dns_rrset, oci:container_instance,
 *                   oci:container_repository, oci:postgresql_db_system,
 *                   oci:object_storage_bucket, oci:queue, oci:vault_secret,
 *                   oci:dynamic_group (+ policy), oci:log_group
 *   minimal         oci:redis_cluster, oci:block_volume
 *   private compute oci:oke_cluster, oci:compute_instance
 *   reads only      oci:mysql_db_system (no safe provider-side password reference)
 */
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../transport";
import { computeDrivers } from "./compute";
import { dataDrivers } from "./data";
import { edgeDrivers } from "./edge";
import { networkDrivers } from "./network";
import { platformDrivers } from "./platform";

export const ociDrivers: ResourceDriver<OciSession>[] = [...networkDrivers, ...edgeDrivers, ...computeDrivers, ...dataDrivers, ...platformDrivers];

/** Idempotent registry writes, including after the registry is rebuilt or Next HMR. */
export function registerOciDrivers(): void {
  for (const d of ociDrivers) registerDriver(d as ResourceDriver);
}
