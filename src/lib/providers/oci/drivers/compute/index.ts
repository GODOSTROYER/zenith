import type { ResourceDriver } from "@/lib/drivers/types";
import type { OciSession } from "../../transport";
import { unsupportedDriver } from "../shared";
import { containerInstanceDriver } from "./container-instance";
import { repositoryDriver } from "./container-repository";

/** Container Instances and OCIR. OKE and plain compute instances are explicitly unsupported. */
export const computeDrivers: ResourceDriver<OciSession>[] = [
  containerInstanceDriver,
  repositoryDriver,
  // OKE needs node pools, networking add-ons and access wiring. Kubernetes
  // workloads belong to the Kubernetes provider once a cluster exists.
  unsupportedDriver("oci:oke_cluster", "kubernetes_cluster"),
  // Expansion does not produce compute instances; image, boot volume and key
  // handling are not modeled. Use a container instance.
  unsupportedDriver("oci:compute_instance", "compute_instance"),
];
