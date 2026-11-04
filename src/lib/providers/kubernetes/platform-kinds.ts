/**
 * The PLATFORM apply set: kinds the platform's own bootstrap identity applies around a tenant namespace
 * (PROD-MAN-04), beyond the kinds `KIND_INFO` renders for workloads.
 *
 *   ClusterRole, ClusterRoleBinding   the per-tenant operator's by-name grant on its own namespace
 *   CiliumNetworkPolicy               the hostname egress policy (cilium.io/v2; the CRD is the operator's)
 *
 * Role, RoleBinding, ServiceAccount, ResourceQuota, LimitRange and NetworkPolicy are already in `KIND_INFO`.
 *
 * These kinds are deliberately NOT in `KIND_INFO`: `prune`, `teardown` and the observe paths iterate it and would
 * start listing cluster-scoped RBAC and a CRD on every cluster (including ones without Cilium). They are accepted
 * only when a caller passes `platform` to `serverSideApply` / `diff`, and then with a vet function that must
 * approve the WHOLE batch first. The vet replaces the exact-name workload-identity RBAC rule (`rbac.ts`), which
 * cannot express an operator role; without a vet the options are refused.
 *
 * Nothing here deletes. Removing a tenant's isolation objects is teardown's job and happens with the namespace.
 */
import { K8sError, type K8sObject } from "./types";

export const PLATFORM_KIND_INFO = {
  ClusterRole: { apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false },
  ClusterRoleBinding: { apiVersion: "rbac.authorization.k8s.io/v1", namespaced: false },
  CiliumNetworkPolicy: { apiVersion: "cilium.io/v2", namespaced: true },
} as const;
export type PlatformKind = keyof typeof PLATFORM_KIND_INFO;

export const isPlatformKind = (k: string): k is PlatformKind => Object.prototype.hasOwnProperty.call(PLATFORM_KIND_INFO, k);

/** What a caller passes to apply the platform kinds. `vet` throws a `K8sError` to refuse the batch. */
export interface PlatformApplyPolicy {
  vet(objects: readonly K8sObject[]): void;
}

/**
 * Apply order when platform kinds are present: identities and quotas first, rules before the bindings that
 * activate them, policies last. Unknown kinds sort last and are refused by validation before any write.
 */
export const PLATFORM_APPLY_ORDER: readonly string[] = [
  "Namespace",
  "ServiceAccount",
  "ResourceQuota",
  "LimitRange",
  "Role",
  "ClusterRole",
  "RoleBinding",
  "ClusterRoleBinding",
  "NetworkPolicy",
  "CiliumNetworkPolicy",
];

export function platformOrder<T extends { kind: string; metadata: { name: string; namespace?: string } }>(objects: readonly T[]): T[] {
  const idx = (k: string) => {
    const i = PLATFORM_APPLY_ORDER.indexOf(k);
    return i === -1 ? PLATFORM_APPLY_ORDER.length : i;
  };
  return [...objects].sort((a, b) => idx(a.kind) - idx(b.kind) || (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") || a.metadata.name.localeCompare(b.metadata.name));
}

export function assertPlatformPolicy(policy: PlatformApplyPolicy | undefined): asserts policy is PlatformApplyPolicy {
  if (!policy || typeof policy.vet !== "function") throw new K8sError("bad_input", "Platform kinds are applied only with a vet function that approves the whole batch.");
}
