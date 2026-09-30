import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { cloudRunJobDriver } from "./cloud-run-job";
import { cloudRunServiceDriver } from "./cloud-run-service";

export const computeDrivers: ResourceDriver<GcpSession>[] = [cloudRunServiceDriver, cloudRunJobDriver];
