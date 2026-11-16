/**
 * All GCP resource drivers and an idempotent registration function.
 *
 * `registerGcpDrivers()` puts every driver in the shared registry
 * (`@/lib/drivers/types`), keyed by (provider, nativeType); calling it twice
 * is harmless. The provider-level index is owned by the orchestrator at
 * integration; this file exists so the GCP package is usable and testable on
 * its own.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { registerDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { buildDrivers } from "./build";
import { computeDrivers } from "./compute";
import { dataDrivers } from "./data";
import { edgeDrivers } from "./edge";
import { identityDrivers } from "./identity";
import { networkDrivers } from "./network";
import { observabilityDrivers } from "./observability";

export const gcpDrivers: ResourceDriver<GcpSession>[] = [
  ...networkDrivers,
  ...identityDrivers,
  ...computeDrivers,
  ...dataDrivers,
  ...buildDrivers,
  ...edgeDrivers,
  ...observabilityDrivers,
];

export function registerGcpDrivers(): void {
  for (const d of gcpDrivers) registerDriver(d as ResourceDriver);
}
