/**
 * Cloud workload identity consumes resolved published attributes only; no
 * generated cloud names, credentials, or OpenTofu interpolations are emitted.
 * These annotations request admission wiring, not proof of cloud access.
 * Cloud trust/federation and cluster webhooks/agents are external prerequisites.
 * EKS Pod Identity needs a cloud-side association, not a SA annotation:
 * https://docs.aws.amazon.com/eks/latest/userguide/pod-id-association.html
 */
import type { IdentityGrant } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import type { K8sRenderContext } from "../types";
import { isRecord } from "../util";
import { identityGrants, isKubernetesNode } from "./identity-grants";

const MECHANISMS = {
  "eks-irsa": { provider: "aws", nativeType: "aws:iam_role", attribute: "arn", annotation: "eks.amazonaws.com/role-arn", valid: /^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]{1,512}$/ },
  "eks-pod-identity": { provider: "aws", nativeType: "aws:iam_role", attribute: "arn", annotation: undefined, valid: /^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]{1,512}$/ },
  gke: { provider: "gcp", nativeType: "gcp:service_account", attribute: "email", annotation: "iam.gke.io/gcp-service-account", valid: /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/ },
  aks: { provider: "azure", nativeType: "azure:user_assigned_identity", attribute: "client_id", annotation: "azure.workload.identity/client-id", valid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
} as const;

export interface CloudIdentityResult {
  annotations: Record<string, string>;
  podLabels: Record<string, string>;
  notes: string[];
}

export function cloudIdentity(node: ResourceNode, ctx: K8sRenderContext, grants: readonly IdentityGrant[]): CloudIdentityResult {
  const result: CloudIdentityResult = { annotations: {}, podLabels: {}, notes: [] };
  const cloudGrants = grants.filter((g) => {
    const target = ctx.node?.(g.target);
    return target && !isKubernetesNode(target);
  });
  if (!cloudGrants.length) return result;
  const config = ctx.workloadIdentity;
  const mechanism = config && Object.prototype.hasOwnProperty.call(MECHANISMS, config.mechanism) ? MECHANISMS[config.mechanism] : undefined;
  const cluster = config && ctx.node?.(config.cluster);
  if (!mechanism || !cluster || cluster.kind !== "kubernetes_cluster" || cluster.provider !== mechanism.provider) {
    result.notes.push(`${node.address}: cloud grants require an explicit workload-identity mechanism and a matching managed-cluster node; no annotation rendered.`);
    return result;
  }
  const eligible: IdentityGrant[] = [];
  for (const g of cloudGrants) {
    if (ctx.node?.(g.target)?.provider !== mechanism.provider) result.notes.push(`${node.address}: grant on ${g.target} does not match the cluster's cloud provider; no cloud binding rendered for that grant.`);
    else eligible.push(g);
  }
  if (!eligible.length) return result;
  // A single SA can select one cloud identity. Match the explicit workload
  // link and coverage of every eligible grant, never address/name conventions.
  const candidates = (ctx.nodes?.() ?? []).filter((n) => {
    if (n.kind !== "identity" || n.provider !== mechanism.provider || n.nativeType !== mechanism.nativeType || !isRecord(n.spec) || typeof node.spec.workload !== "string" || n.spec.workload !== node.spec.workload) return false;
    let declared: IdentityGrant[];
    try { declared = identityGrants(n); } catch { return false; }
    return eligible.every((g) => declared.some((d) => d.target === g.target && g.access.every((v) => d.access.includes(v))));
  });
  if (candidates.length !== 1) {
    result.notes.push(`${node.address}: ${candidates.length ? "ambiguous" : "missing"} cloud identity covering the workload's grants; no annotation rendered.`);
    return result;
  }
  const identity = candidates[0];
  let value: unknown;
  try { value = ctx.resolveAttribute?.(identity.address, mechanism.attribute); } catch { /* unresolved: never expose resolver errors */ }
  if (typeof value !== "string" || !mechanism.valid.test(value)) {
    result.notes.push(`${node.address}: cloud identity ${identity.address} has no resolved valid published ${mechanism.attribute}; no annotation rendered.`);
    return result;
  }
  if (config?.mechanism === "eks-pod-identity") {
    result.notes.push(`${node.address}: EKS Pod Identity requires a cloud-side association for this cluster, namespace and ServiceAccount using ${identity.address}'s published arn, plus the Pod Identity agent; no ServiceAccount annotation exists and this renderer does not create the association.`);
    return result;
  }
  if (mechanism.annotation) result.annotations[mechanism.annotation] = value;
  if (config?.mechanism === "aks") result.podLabels["azure.workload.identity/use"] = "true";
  result.notes.push(`${node.address}: ${config?.mechanism} uses ${identity.address}'s published ${mechanism.attribute}; cloud trust/federation and cluster admission wiring must already exist. Effective cloud access is unverified.`);
  return result;
}
