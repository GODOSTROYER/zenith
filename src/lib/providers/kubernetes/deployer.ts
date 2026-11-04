/**
 * The DEPLOYER half of a `scoped_guest` Kubernetes connection (PROD-K8S-CONN).
 *
 * One connection serves two roles with two separate credentials:
 *   - minter (`credentialRef`): namespaced, manages guest ServiceAccount/Role/RoleBinding and requests
 *     their tokens. Used ONLY for guest sessions and the guest-binding lifecycle (guest.ts).
 *   - deployer (`deployerCredentialRef`): used ONLY by the deploy/observe provider path (plan, apply,
 *     observe, release) through the credential broker and the durable authority guard chain. Declared
 *     `namespaced` (verified to hold no cluster-wide or system-namespace power) or `cluster`.
 *
 * Neither credential can stand in for the other: the broker picks the vault reference by the purpose
 * of the request, there is no fallback when a part is missing or fails, and a deployer whose resolved
 * credential equals the minter's is refused (the separation would be a fiction).
 *
 * This module only holds the pure policy (what verification demands and the fixed refusals). The
 * cluster access goes through the same SelfSubjectAccessReview port as the minter checks.
 */
import { GuestCredentialError, SYSTEM_NAMESPACES, assertGuestNamespace, type AccessAttributes, type GuestClusterPort } from "./guest";

export type DeployerScope = "namespaced" | "cluster";

export type DeployerErrorCode =
  | "not_configured"
  | "scope_refused"
  | "same_as_minter"
  | "overprivileged"
  | "insufficient"
  | "rejected"
  | "cluster_error";

const MESSAGES: Record<DeployerErrorCode, string> = {
  not_configured: "This Kubernetes connection has no deployer credential; it serves guest sessions only. Add one with connection.rotate (deployerCredentialRef).",
  scope_refused: "The Kubernetes deployer scope or namespace allowlist is not permitted for this connection.",
  same_as_minter: "The Kubernetes deployer credential is the same credential as the guest minter; the two roles must use separate credentials.",
  overprivileged: "The Kubernetes deployer credential declared as namespaced holds cluster-wide or system-namespace privilege.",
  insufficient: "The Kubernetes deployer credential cannot read and deploy in every allowlisted namespace.",
  rejected: "The Kubernetes API rejected the deployer credential.",
  cluster_error: "The Kubernetes API could not complete the deployer verification.",
};

/** A fixed-message refusal. `code` is stable and safe to persist or show. */
export class DeployerCredentialError extends Error {
  readonly code: DeployerErrorCode;
  constructor(code: DeployerErrorCode) {
    super(MESSAGES[code]);
    this.name = "DeployerCredentialError";
    this.code = code;
  }
}

export const DEPLOYER_SCOPES: readonly DeployerScope[] = ["namespaced", "cluster"];
export const deployerScopeOf = (config: { deployerScope?: DeployerScope }): DeployerScope => config.deployerScope ?? "namespaced";

/** A namespaced deployer must NOT hold any of these (same floor as the minter, plus nothing it legitimately needs). */
const FORBIDDEN_FOR_NAMESPACED: readonly AccessAttributes[] = [
  { verb: "*", group: "*", resource: "*" },
  { verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterrolebindings" },
  { verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterroles" },
  { verb: "get", group: "", resource: "secrets", namespace: "kube-system" },
  { verb: "create", group: "", resource: "pods", subresource: "exec", namespace: "kube-system" },
  { verb: "create", group: "", resource: "serviceaccounts", subresource: "token", namespace: "kube-system" },
];

/** Every deployer (either scope) must read and deploy in each allowlisted namespace. */
const REQUIRED_FOR_DEPLOYER = (namespace: string): AccessAttributes[] => [
  { verb: "get", group: "", resource: "serviceaccounts", namespace },
  { verb: "list", group: "", resource: "pods", namespace },
  { verb: "get", group: "apps", resource: "deployments", namespace },
  { verb: "patch", group: "apps", resource: "deployments", namespace },
];

function translate(error: unknown): never {
  if (error instanceof DeployerCredentialError) throw error;
  if (error instanceof GuestCredentialError) throw new DeployerCredentialError(error.code === "minter_rejected" ? "rejected" : "cluster_error");
  throw new DeployerCredentialError("cluster_error");
}

/**
 * Connection verification of the deployer part. Creates nothing. `namespaces` is the connection allowlist
 * (never system namespaces). A namespaced deployer must be denied every cluster-wide probe; a cluster
 * deployer needs no denial but must still deploy in every allowlisted namespace.
 */
export async function verifyDeployerCredential(cluster: Pick<GuestClusterPort, "allowed">, input: { scope: DeployerScope; namespaces: readonly string[] }): Promise<void> {
  if (!DEPLOYER_SCOPES.includes(input.scope) || !input.namespaces.length) throw new DeployerCredentialError("scope_refused");
  try {
    for (const namespace of input.namespaces) {
      if (SYSTEM_NAMESPACES.has(namespace)) throw new DeployerCredentialError("scope_refused");
      try { assertGuestNamespace(namespace, input.namespaces); } catch { throw new DeployerCredentialError("scope_refused"); }
    }
    if (input.scope === "namespaced") {
      for (const attributes of FORBIDDEN_FOR_NAMESPACED) if (await cluster.allowed(attributes)) throw new DeployerCredentialError("overprivileged");
    }
    for (const namespace of input.namespaces) {
      for (const attributes of REQUIRED_FOR_DEPLOYER(namespace)) if (!(await cluster.allowed(attributes))) throw new DeployerCredentialError("insufficient");
    }
  } catch (error) { translate(error); }
}
