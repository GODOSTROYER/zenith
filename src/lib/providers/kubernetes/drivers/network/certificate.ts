/**
 * `k8s:Certificate` — tls_certificate via cert-manager.
 *
 * On a cluster without cert-manager the kind is not served: observe reports
 * `missing` with the reason instead of pretending, and discover returns
 * nothing for this kind.
 */
import type { TlsCertificateSpec } from "@/lib/resources/specs";
import { tlsSecretName } from "../../naming";
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { certificateRuntime } from "../runtime";
import { attributeCheck, makeKubernetesDriver, type KindDef } from "../shared";

function readyCondition(live: Record<string, unknown>): string | undefined {
  const conds = dig(live, "status", "conditions");
  const ready = Array.isArray(conds) ? conds.find((c) => isRecord(c) && c.type === "Ready") : undefined;
  return isRecord(ready) && typeof ready.status === "string" ? ready.status : undefined;
}

export const certificateDef: KindDef = {
  suffix: "certificate",
  nativeType: "k8s:Certificate",
  kind: "Certificate",
  portable: ["tls_certificate"],
  attributes: (live) => ({
    dnsNames: sortedStrings(dig(live, "spec", "dnsNames")),
    secretName: dig(live, "spec", "secretName"),
    issuer: dig(live, "spec", "issuerRef", "name"),
    ready: readyCondition(live) ?? null,
  }),
  expected: safeExpected((node) => {
    const s = node.spec as unknown as Partial<TlsCertificateSpec>;
    if (typeof s.domain !== "string") return {};
    // the issuer is a render option (cluster-specific ClusterIssuer names), so it is reported, not compared
    return { dnsNames: [s.domain], secretName: tlsSecretName(s.domain) };
  }),
  summary: (live) => compact({ dnsNames: sortedStrings(dig(live, "spec", "dnsNames")).join(",") || undefined }),
  runtime: certificateRuntime,
  extraChecks: (_node, observation) => [attributeCheck(observation, "ready", "issued", "cert-manager reports the certificate Ready", (v) => v === "True")],
};

export const certificateDriver = makeKubernetesDriver(certificateDef);
