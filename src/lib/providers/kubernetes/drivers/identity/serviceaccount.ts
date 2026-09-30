/**
 * `k8s:ServiceAccount` — identity.
 *
 * The account is a stable handle for workloads; this driver does not translate
 * `IdentitySpec.grants` into RBAC or cloud workload-identity bindings, so a
 * passing verify says the account exists and does not auto-mount a token, not
 * that any grant is in force.
 */
import { dig } from "../../util";
import { makeKubernetesDriver, type KindDef } from "../shared";

export const serviceAccountDef: KindDef = {
  suffix: "serviceaccount",
  nativeType: "k8s:ServiceAccount",
  kind: "ServiceAccount",
  portable: ["identity"],
  attributes: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  expected: () => ({ automountServiceAccountToken: false }),
  summary: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  skipDiscovery: (live) => dig(live, "metadata", "name") === "default",
};

export const serviceAccountDriver = makeKubernetesDriver(serviceAccountDef);
