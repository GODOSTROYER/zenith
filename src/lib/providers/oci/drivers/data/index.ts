import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { mysqlDriver } from "./mysql";
import { volumeDriver } from "./block-volume";
import { bucketDriver } from "./object-storage-bucket";
import { postgresDriver } from "./postgresql";
import { queueDriver } from "./queue";
import { redisDriver } from "./redis";

/** Data services; MySQL supports reads but cannot safely compile credentials. */
export const dataDrivers: ResourceDriver<OciSession>[] = [
  postgresDriver,
  bucketDriver,
  queueDriver,
  redisDriver,
  volumeDriver,
  mysqlDriver,
];
