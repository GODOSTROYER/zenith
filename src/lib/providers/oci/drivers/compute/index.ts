import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { unsupportedDriver } from "../shared";
import { containerInstanceDriver } from "./container-instance";
import { repositoryDriver } from "./container-repository";

/** Container Instances and OCIR. OKE and plain compute instances are explicitly unsupported. */
export const computeDrivers: ResourceDriver<OciSession>[] = [
  containerInstanceDriver,
  repositoryDriver,
  unsupportedDriver(
    "oci:oke_cluster",
    "kubernetes_cluster",
    "An OKE cluster without node pools, networking add-ons and access wiring would be a cluster nobody can use, so none is compiled or observed. Kubernetes workloads on OKE belong to the Kubernetes provider once a cluster exists."
  ),
  unsupportedDriver(
    "oci:compute_instance",
    "compute_instance",
    "Compute instances are never produced by expansion today and need image, boot volume and key handling that this workstream does not model. Use a container instance."
  ),
];
