/** Composition of the contract-tested provider drivers. No registration performs I/O. */
import { registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { registerKubernetesDrivers, renderGraph, serverSideApply } from "@/lib/providers/kubernetes";
import { createK8sClient, readObject, listObjects } from "@/lib/providers/kubernetes/client";
import { isSupportedKind, K8sError } from "@/lib/providers/kubernetes/types";
import { registerZenithDrivers } from "@/lib/providers/zenith";
import { registerGcpDrivers } from "@/lib/providers/gcp";
import { registerAzureDrivers } from "@/lib/providers/azure";
import { registerOciDrivers } from "@/lib/providers/oci";

/** Re-registering the same set is idempotent, including after Next HMR. */
export function registerAllDrivers(): void {
  registerAwsDrivers();
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
