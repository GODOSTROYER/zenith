/**
 * Pure cloud trust selection shared by the three identity drivers. The fixed
 * CompileContext has lookup, not graph enumeration: the workload must link its
 * Kubernetes identity and cluster through dependencies (or explicit
 * spec.serviceAccount/spec.cluster addresses on the cloud identity). Names and
 * namespaces come from the Kubernetes renderer; ambiguous links fail closed.
 * No external cluster or ServiceAccount is changed. Evidence is contract only.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { isDnsLabel, objectName } from "@/lib/providers/kubernetes/naming";
import { namespaceOf } from "@/lib/providers/kubernetes/renderers/common";

export type WorkloadTrust =
  | { state: "none" }
  | { state: "unresolved"; note: string }
  | { state: "ready"; cluster: ResourceNode; account: ResourceNode; namespace: string; name: string; subject: string };

const CLUSTER_TYPES = { aws: "aws:eks_cluster", gcp: "gcp:gke_cluster", azure: "azure:aks_cluster" };
const isKubernetes = (n: ResourceNode) => n.provider === "kubernetes" || n.provider === "zenith";

export function workloadTrust(node: ResourceNode, ctx: CompileContext): WorkloadTrust {
  const workload = typeof node.spec.workload === "string" ? ctx.node(node.spec.workload) : undefined;
  const explicitCluster = node.spec.cluster ?? workload?.spec.cluster;
  const explicitAccount = node.spec.serviceAccount;
  const links = [...new Set([...node.dependsOn, ...(workload?.dependsOn ?? [])])].sort().map(ctx.node).filter((n): n is ResourceNode => !!n);
  const clusters = explicitCluster === undefined ? links.filter((n) => n.kind === "kubernetes_cluster") : typeof explicitCluster === "string" ? [ctx.node(explicitCluster)].filter((n): n is ResourceNode => !!n) : [];
  if ((!workload || !isKubernetes(workload)) && explicitCluster === undefined && clusters.length === 0) return { state: "none" };
  const unresolved = (reason: string): WorkloadTrust => ({ state: "unresolved", note: `${node.address}: ${reason}; no cloud workload trust rendered. Effective cloud access is unverified.` });
  if (!workload || !isKubernetes(workload) || workload.ownership !== "managed") return unresolved("workload must be a managed Kubernetes workload");
  if (clusters.length !== 1) return unresolved("one explicit in-graph cluster is required");
  const cluster = clusters[0];
  if (cluster.ownership !== "managed") return unresolved("referenced/external clusters require customer-managed trust");
  if (cluster.kind !== "kubernetes_cluster" || cluster.provider !== node.provider || cluster.nativeType !== CLUSTER_TYPES[node.provider as keyof typeof CLUSTER_TYPES]) return unresolved("cluster provider/native type does not match this identity");
  const accounts = explicitAccount === undefined ? links.filter((n) => n.kind === "identity" && isKubernetes(n) && n.spec.workload === workload.address) : typeof explicitAccount === "string" ? [ctx.node(explicitAccount)].filter((n): n is ResourceNode => !!n) : [];
  if (accounts.length !== 1) return unresolved("one explicitly linked Kubernetes identity is required");
  const account = accounts[0];
  if (account.kind !== "identity" || !isKubernetes(account) || account.ownership !== "managed" || account.spec.workload !== workload.address) return unresolved("ServiceAccount must be a managed identity for this workload");
  const namespace = namespaceOf(account, ctx.environmentId, ctx.node);
  if (!isDnsLabel(namespace) || namespace !== namespaceOf(workload, ctx.environmentId, ctx.node)) return unresolved("ServiceAccount must use a valid workload namespace");
  const name = objectName(account);
  return { state: "ready", cluster, account, namespace, name, subject: `system:serviceaccount:${namespace}:${name}` };
}
