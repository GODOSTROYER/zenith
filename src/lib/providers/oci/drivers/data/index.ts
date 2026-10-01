import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { unsupportedDriver } from "../shared";
import { volumeDriver } from "./block-volume";
import { bucketDriver } from "./object-storage-bucket";
import { postgresDriver } from "./postgresql";
import { queueDriver } from "./queue";
import { redisDriver } from "./redis";

/** PostgreSQL, Object Storage, Queue, Cache (minimal), block volumes (minimal); MySQL is explicitly unsupported. */
export const dataDrivers: ResourceDriver<OciSession>[] = [
  postgresDriver,
  bucketDriver,
  queueDriver,
  redisDriver,
  volumeDriver,
  unsupportedDriver(
    "oci:mysql_db_system",
    "mysql",
    "HeatWave MySQL is not compiled or observed; expansion never produces a mysql node today, and a half-built database driver would be worse than none."
  ),
];
