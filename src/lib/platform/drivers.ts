/** Composition of the contract-tested provider drivers. No registration performs I/O. */
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { networkDrivers } from "@/lib/providers/aws/drivers/network";
import { COMPUTE_DRIVERS } from "@/lib/providers/aws/drivers/compute";
import { awsDataDrivers } from "@/lib/providers/aws/drivers/data";
import { registerKubernetesDrivers, renderGraph, serverSideApply } from "@/lib/providers/kubernetes";
import { createK8sClient, readObject, listObjects } from "@/lib/providers/kubernetes/client";
import { isSupportedKind, K8sError } from "@/lib/providers/kubernetes/types";
import { registerZenithDrivers } from "@/lib/providers/zenith";
import { registerGcpDrivers } from "@/lib/providers/gcp";
import { registerAzureDrivers } from "@/lib/providers/azure";
import { registerOciDrivers } from "@/lib/providers/oci";

/** Re-registering the same set is idempotent, including after Next HMR. */
export function registerAllDrivers(): void {
  for (const driver of [...networkDrivers, ...COMPUTE_DRIVERS, ...awsDataDrivers]) registerDriver(driver as ResourceDriver);
  registerKubernetesDrivers();
  // This package owns the managed substrate; never register the k8s package's zenith aliases.
  registerZenithDrivers({ toolkit: {
    renderGraph,
    apply: serverSideApply,
    read: (session, ref, signal) => readObject(createK8sClient(session, { signal }), ref),
    list: (session, query, signal) => {
      if (!isSupportedKind(query.kind)) throw new K8sError("unsupported", "This Kubernetes kind is not supported by the managed toolkit.");
      return listObjects(createK8sClient(session, { signal }), query.kind, query.namespace, query);
    },
  } });
  registerGcpDrivers();
  registerAzureDrivers();
  registerOciDrivers();
}
