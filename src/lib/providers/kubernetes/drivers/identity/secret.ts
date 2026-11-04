/**
 * `k8s:Secret` — secret.
 *
 * The API returns the Secret's data on GET; this driver discards it on the spot
 * and reports KEY NAMES only (`keys`), the type and the reference annotation.
 * It never reads, hashes, compares or returns a value, so drift on a secret's
 * VALUE is not detectable here by design; rotate by re-applying.
 */
import type { SecretSpec } from "@/lib/resources/specs";
import { ANNOTATION, SECRET_DATA_KEY } from "../../types";
import { dig, isRecord } from "../../util";
import { safeExpected } from "../attrs";
import { makeKubernetesDriver, type KindDef } from "../shared";

export const secretDef: KindDef = {
  suffix: "secret",
  nativeType: "k8s:Secret",
  kind: "Secret",
  portable: ["secret"],
  attributes: (live) => {
    const data = dig(live, "data");
    return {
      keys: isRecord(data) ? Object.keys(data).sort() : [],
      type: typeof live.type === "string" ? live.type : undefined,
      secretRef: dig(live, "metadata", "annotations", ANNOTATION.secretRef),
    };
  },
  expected: safeExpected((node) => {
    const s = node.spec as unknown as Partial<SecretSpec>;
    return typeof s.secretRef === "string" ? { secretRef: s.secretRef, type: "Opaque", keys: [SECRET_DATA_KEY] } : {};
  }),
  summary: (live) => {
    const data = dig(live, "data");
    return { type: typeof live.type === "string" ? live.type : "Opaque", keyCount: isRecord(data) ? Object.keys(data).length : 0 };
  },
  skipDiscovery: (live) => typeof live.type === "string" && (live.type === "kubernetes.io/service-account-token" || live.type === "helm.sh/release.v1"),
};

export const secretDriver = makeKubernetesDriver(secretDef);
