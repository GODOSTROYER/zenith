/**
 * The Kubernetes provider's render/apply/read/list as the managed provider's `KubernetesToolkit` port.
 * One definition shared by the driver registry (`drivers.ts`) and the managed substrate composition
 * (`zenith-managed.ts`), so drivers and the apply pipeline can never disagree about how the cluster is driven.
 * Every method takes the (tenant-scoped) session; none constructs credentials.
 */
import { renderGraph, serverSideApply } from "@/lib/providers/kubernetes";
import { createK8sClient, listObjects, readObject } from "@/lib/providers/kubernetes/client";
import { isSupportedKind, K8sError } from "@/lib/providers/kubernetes/types";
import type { KubernetesToolkit } from "@/lib/providers/zenith/k8s-port";

export function createKubernetesToolkit(): KubernetesToolkit {
  return {
    renderGraph,
    apply: serverSideApply,
    read: (session, ref, signal) => readObject(createK8sClient(session, { signal }), ref),
    list: (session, query, signal) => {
      if (!isSupportedKind(query.kind)) throw new K8sError("unsupported", "This Kubernetes kind is not supported by the managed toolkit.");
      return listObjects(createK8sClient(session, { signal }), query.kind, query.namespace, query);
    },
  };
}
