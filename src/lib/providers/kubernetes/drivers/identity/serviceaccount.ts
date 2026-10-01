/**
 * `k8s:ServiceAccount` — identity.
 *
 * Rendering translates grants, but this reader observes only the account.
 * Effective RBAC/cloud access is unknown until separately inspected. A bound
 * token is enabled only for rendered RBAC (or an explicit context opt-in).
 */
import { dig } from "../../util";
import { makeKubernetesDriver, type KindDef } from "../shared";

export const serviceAccountDef: KindDef = {
  suffix: "serviceaccount",
  nativeType: "k8s:ServiceAccount",
  kind: "ServiceAccount",
  portable: ["identity"],
  attributes: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  // A driver has no graph/context: it cannot know which grants rendered RBAC.
  expected: (node) => Array.isArray(node.spec.grants) && node.spec.grants.length ? {} : { automountServiceAccountToken: false },
  extraChecks: (node) => Array.isArray(node.spec.grants) && node.spec.grants.length ? [{
    id: "grants", description: "identity grants are effective", passed: "unknown",
    detail: "ServiceAccount observation alone does not inspect RBAC, cloud trust/federation, admission wiring or effective permissions.",
  }] : [],
  summary: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  skipDiscovery: (live) => dig(live, "metadata", "name") === "default",
};

export const serviceAccountDriver = makeKubernetesDriver(serviceAccountDef);
