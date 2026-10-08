/** Read-only node admission, independent of the build controller credential. */
import { digest } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";
import { listByKind, type K8sClient } from "../client";
import { dig, isRecord } from "../util";
import type { IsolatedBuildConfig } from "./config";
import { BUILD_NODE_LABEL, BUILD_PROFILE_LABEL, BUILD_TAINT } from "./render";

export function verifyBuildNodes(c: IsolatedBuildConfig, nodes: Record<string, unknown>[], pods: Record<string, unknown>[], selected?: string): string {
  const pool = nodes.filter(node => dig(node, "metadata", "labels", BUILD_NODE_LABEL) === c.nodeIsolation.tenant);
  if (!pool.length || selected && !pool.some(node => dig(node, "metadata", "name") === selected)) {
    throw new StepFailedError("No tenant-dedicated build node is available; source execution is refused.");
  }
  for (const node of pool) {
    const name = dig(node, "metadata", "name"), taints = dig(node, "spec", "taints");
    const ready = dig(node, "status", "conditions");
    if (typeof name !== "string" || typeof dig(node, "metadata", "uid") !== "string" || !dig(node, "metadata", "uid") || dig(node, "metadata", "deletionTimestamp") || dig(node, "spec", "unschedulable") === true ||
        dig(node, "metadata", "labels", "kubernetes.io/hostname") !== name ||
        dig(node, "metadata", "labels", BUILD_PROFILE_LABEL) !== c.nodeIsolation.profileDigest.slice(0, 63) ||
        !Array.isArray(ready) || !ready.some(condition => isRecord(condition) && condition.type === "Ready" && condition.status === "True") ||
        !Array.isArray(taints) || !["NoSchedule", "NoExecute"].every(effect => taints.some(taint =>
          isRecord(taint) && taint.key === BUILD_TAINT && taint.value === c.nodeIsolation.tenant && taint.effect === effect))) {
      throw new StepFailedError("Build node isolation or the reviewed runtime profile is absent, changed or not ready.");
    }
    for (const pod of pods.filter(p => dig(p, "spec", "nodeName") === name && !["Succeeded", "Failed"].includes(String(dig(p, "status", "phase"))))) {
      const owners = dig(pod, "metadata", "ownerReferences");
      const owned = Array.isArray(owners) && owners.some(owner => isRecord(owner) && owner.controller === true &&
        (dig(pod, "metadata", "namespace") === c.namespace && owner.kind === "Job" &&
         dig(pod, "metadata", "labels", "zenith.dev/isolated-build") === "true" ||
         dig(pod, "metadata", "namespace") === "kube-system" && owner.kind === "DaemonSet" &&
         c.nodeIsolation.systemDaemonSets.includes(String(owner.name))));
      if (!owned) throw new StepFailedError("The build node also runs an unapproved workload; tenant node isolation cannot be proven.");
    }
  }
  // Do not bind ephemeral node status/resource versions: bind allocation and the protected profile labels.
  return digest(pool.map(node => [dig(node, "metadata", "uid"), dig(node, "metadata", "name"), dig(node, "metadata", "labels", BUILD_NODE_LABEL),
    dig(node, "metadata", "labels", BUILD_PROFILE_LABEL), dig(node, "spec", "taints")]).sort());
}
export async function assertBuildNodes(client: K8sClient, c: IsolatedBuildConfig, selected?: string): Promise<string> {
  const nodes = await listByKind(client, { apiVersion: "v1", kind: "Node", namespaced: false }, undefined, { maxPages: 5 });
  const pods = await listByKind(client, { apiVersion: "v1", kind: "Pod", namespaced: false }, undefined, { maxPages: 5 });
  if (nodes.truncated || nodes.unavailable || pods.truncated || pods.unavailable) {
    throw new StepFailedError("Complete node and workload readback is required to prove tenant build isolation.");
  }
  return verifyBuildNodes(c, nodes.items, pods.items, selected);
}
