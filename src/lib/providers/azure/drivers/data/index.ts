import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import { postgresDriver } from "@/lib/providers/azure/drivers/data/postgres";
import { redisDriver } from "@/lib/providers/azure/drivers/data/redis";
import { serviceBusQueueDriver, serviceBusTopicDriver } from "@/lib/providers/azure/drivers/data/service-bus";
import { storageDriver } from "@/lib/providers/azure/drivers/data/storage";

/** Data group: PostgreSQL, Redis, Blob storage, Service Bus. */
export const dataDrivers: ResourceDriver<AzureSession>[] = [postgresDriver, redisDriver, storageDriver, serviceBusQueueDriver, serviceBusTopicDriver];
