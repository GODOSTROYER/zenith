/** Composition of the contract-tested provider drivers. No registration performs I/O. */
import { registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes";
import { createKubernetesToolkit } from "./kubernetes-toolkit";
import { registerZenithDrivers } from "@/lib/providers/zenith";
import { registerGcpDrivers } from "@/lib/providers/gcp";
import { registerAzureDrivers } from "@/lib/providers/azure";
import { registerOciDrivers } from "@/lib/providers/oci";

/** Re-registering the same set is idempotent, including after Next HMR. */
export function registerAllDrivers(): void {
  registerAwsDrivers();
  registerKubernetesDrivers();
  // This package owns the managed substrate; never register the k8s package's zenith aliases.
  registerZenithDrivers({ toolkit: createKubernetesToolkit() });
  registerGcpDrivers();
  registerAzureDrivers();
  registerOciDrivers();
}
