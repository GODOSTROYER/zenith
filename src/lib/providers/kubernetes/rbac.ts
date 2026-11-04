/**
 * Namespaced RBAC only, with exact names and explicit API verbs. Both render
 * and apply validate this boundary. create/deletecollection cannot be pinned
 * to resourceNames; bind/escalate/impersonate and subresources are unsupported.
 * https://kubernetes.io/docs/reference/access-authn-authz/rbac/
 */
import { isDnsLabel } from "./naming";
import { ANNOTATION, K8sError, type K8sObject } from "./types";
import { isRecord } from "./util";

/** Closed mapping of namespaced primary objects; pluralization is never guessed. */
export const RBAC_TARGETS: Readonly<Record<string, { group: string; resource: string }>> = {
  Secret: { group: "", resource: "secrets" },
  ConfigMap: { group: "", resource: "configmaps" },
  Service: { group: "", resource: "services" },
  ServiceAccount: { group: "", resource: "serviceaccounts" },
  PersistentVolumeClaim: { group: "", resource: "persistentvolumeclaims" },
  ResourceQuota: { group: "", resource: "resourcequotas" },
  LimitRange: { group: "", resource: "limitranges" },
  Deployment: { group: "apps", resource: "deployments" },
  StatefulSet: { group: "apps", resource: "statefulsets" },
  CronJob: { group: "batch", resource: "cronjobs" },
  NetworkPolicy: { group: "networking.k8s.io", resource: "networkpolicies" },
  Ingress: { group: "networking.k8s.io", resource: "ingresses" },
  HorizontalPodAutoscaler: { group: "autoscaling", resource: "horizontalpodautoscalers" },
  Certificate: { group: "cert-manager.io", resource: "certificates" },
  HTTPRoute: { group: "gateway.networking.k8s.io", resource: "httproutes" },
  DNSEndpoint: { group: "externaldns.k8s.io", resource: "dnsendpoints" },
};
export const RBAC_VERBS = new Set(["get", "list", "watch", "update", "patch", "delete"]);
export const isResourceName = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 253 && v.split(".").every(isDnsLabel);

export function validateRbac(object: K8sObject, code: "render_error" | "invalid_object"): void {
  const fail = () => { throw new K8sError(code, "RBAC requires namespaced Roles with exact resource names and verbs, and RoleBindings to one namespaced ServiceAccount."); };
  if (object.kind === "Role") {
    if (!Array.isArray(object.rules) || object.rules.length === 0) return fail();
    for (const rule of object.rules) {
      if (!isRecord(rule) || Object.keys(rule).some((k) => !["apiGroups", "resources", "resourceNames", "verbs"].includes(k))) return fail();
      if (!Array.isArray(rule.apiGroups) || rule.apiGroups.length !== 1 || !Array.isArray(rule.resources) || rule.resources.length !== 1) return fail();
      const group: unknown = rule.apiGroups[0];
      const resource: unknown = rule.resources[0];
      if (!Object.values(RBAC_TARGETS).some((t) => t.group === group && t.resource === resource)) return fail();
      if (!Array.isArray(rule.resourceNames) || rule.resourceNames.length === 0 || !rule.resourceNames.every(isResourceName)) return fail();
      if (!Array.isArray(rule.verbs) || rule.verbs.length === 0 || !rule.verbs.every((v) => typeof v === "string" && RBAC_VERBS.has(v))) return fail();
    }
  } else if (object.kind === "RoleBinding") {
    const ref = object.roleRef;
    if (!isRecord(ref) || ref.apiGroup !== "rbac.authorization.k8s.io" || ref.kind !== "Role" || typeof ref.name !== "string" || !isDnsLabel(ref.name)) return fail();
    if (!Array.isArray(object.subjects) || object.subjects.length !== 1) return fail();
    const subject: unknown = object.subjects[0];
    if (!isRecord(subject) || subject.kind !== "ServiceAccount" || (subject.apiGroup !== undefined && subject.apiGroup !== "") || typeof subject.name !== "string" || !isDnsLabel(subject.name) || typeof subject.namespace !== "string" || !isDnsLabel(subject.namespace)) return fail();
  }
}

/** A binding cannot borrow an uninspected/foreign Role or another node's identity. */
export function validateRbacCompanions(object: K8sObject, objects: readonly K8sObject[]): void {
  if (object.kind !== "RoleBinding" || !isRecord(object.roleRef) || !Array.isArray(object.subjects)) return;
  const roleRef = object.roleRef;
  const subject: unknown = object.subjects[0];
  if (!isRecord(subject)) return;
  const role = objects.find((o) => o.kind === "Role" && o.metadata?.namespace === object.metadata.namespace && o.metadata?.name === roleRef.name);
  const account = objects.find((o) => o.kind === "ServiceAccount" && o.metadata?.namespace === subject.namespace && o.metadata?.name === subject.name);
  for (const companion of [role, account]) {
    if (!companion || companion.metadata.annotations?.[ANNOTATION.resource] !== object.metadata.annotations?.[ANNOTATION.resource] || companion.metadata.annotations?.[ANNOTATION.environment] !== object.metadata.annotations?.[ANNOTATION.environment]) {
      throw new K8sError("invalid_object", "A RoleBinding requires its exact Role and ServiceAccount in the same apply batch with matching Zenith ownership annotations.");
    }
  }
}
