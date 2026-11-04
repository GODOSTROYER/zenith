import type { ResourceDriver } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { cloudSqlInstanceDriver } from "./cloud-sql-instance";
import { memorystoreInstanceDriver } from "./memorystore-instance";
import { pubsubTopicDriver } from "./pubsub-topic";
import { secretManagerSecretDriver } from "./secret-manager-secret";
import { storageBucketDriver } from "./storage-bucket";

export const dataDrivers: ResourceDriver<GcpSession>[] = [cloudSqlInstanceDriver, memorystoreInstanceDriver, storageBucketDriver, pubsubTopicDriver, secretManagerSecretDriver];
