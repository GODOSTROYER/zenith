import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { computeInstanceDriver } from "./compute-instance";
import { containerInstanceDriver } from "./container-instance";
import { repositoryDriver } from "./container-repository";
import { okeClusterDriver } from "./oke-cluster";

/** Container Instances, OCIR, private VMs and enhanced private OKE clusters. */
export const computeDrivers: ResourceDriver<OciSession>[] = [
  containerInstanceDriver,
  repositoryDriver,
  okeClusterDriver,
  computeInstanceDriver,
];
