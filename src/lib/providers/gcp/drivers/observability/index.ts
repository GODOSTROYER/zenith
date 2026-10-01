import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { logBucketDriver } from "./log-bucket";

export const observabilityDrivers: ResourceDriver<GcpSession>[] = [logBucketDriver];
