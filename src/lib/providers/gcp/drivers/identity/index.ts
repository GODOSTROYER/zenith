import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { serviceAccountDriver } from "./service-account";

export const identityDrivers: ResourceDriver<GcpSession>[] = [serviceAccountDriver];
