/** Least-privilege custody RBAC. Operator applies it separately from a deployment approval. */
import type { K8sObject } from "../types";
import type { IsolatedBuildConfig } from "./config";

export function renderBuildCustody(c: IsolatedBuildConfig): K8sObject[] {
  const out: K8sObject[] = [];
  const controller = { kind: "ServiceAccount", name: "zenith-build-controller", namespace: c.namespace };
  const verifier = { kind: "ServiceAccount", name: "zenith-build-verifier", namespace: c.proxy.namespace };
  for (const subject of [controller, verifier]) out.push({
    apiVersion: "v1", kind: "ServiceAccount", metadata: { name: subject.name, namespace: subject.namespace }, automountServiceAccountToken: false,
  });
  const rules = (build: boolean) => [
    { apiGroups: [""], resources: ["pods", "serviceaccounts", "resourcequotas"], verbs: ["get", "list"] },
    { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["get", "list"] },
    ...(!build ? [
      { apiGroups: [""], resources: ["configmaps", "services"], verbs: ["get", "list"] },
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["get"] },
    ] : []),
  ];
  const bind = (namespace: string, name: string, subject: typeof controller, roleName = name) =>
    out.push({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name, namespace }, subjects: [subject],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: roleName } } as unknown as K8sObject);
  for (const namespace of [c.namespace, c.proxy.namespace]) {
    const build = namespace === c.namespace;
    out.push({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "zenith-build-read", namespace }, rules: rules(build) } as unknown as K8sObject);
    bind(namespace, "zenith-build-read", verifier);
    if (!build) bind(namespace, "zenith-build-controller-read", controller, "zenith-build-read");
  }
  out.push({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "zenith-build-controller", namespace: c.namespace },
    rules: [...rules(true), { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "create"] },
      { apiGroups: [""], resources: ["secrets"], verbs: ["get", "create"] }] } as unknown as K8sObject);
  bind(c.namespace, "zenith-build-controller", controller);
  const global = "zenith-build-verifier-" + c.nodeIsolation.tenant;
  out.push({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: global },
    rules: [
      { apiGroups: [""], resources: ["nodes", "pods", "namespaces"], verbs: ["get", "list"] },
      { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get"] },
      { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings", "clusterrolebindings", "roles", "clusterroles"], verbs: ["get", "list"] },
    ] } as unknown as K8sObject);
  out.push({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", metadata: { name: global }, subjects: [verifier],
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: global } } as unknown as K8sObject);
  return out;
}
