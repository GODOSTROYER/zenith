/**
 * `k8s:NetworkPolicy` — firewall.
 *
 * Observed: which policy types apply and which TCP ports the ingress rules
 * open. Whether the CNI actually ENFORCES NetworkPolicy is a cluster property
 * this driver cannot read; a passing verify here means the policy object is
 * present and shaped as desired, not that traffic is blocked.
 *
 * `ingressPorts` is expected only when the desired rule is expressible inside
 * the cluster: a public_http rule (target is a load balancer whose backend
 * ports depend on the graph) omits it, and a cross-boundary source has no
 * in-cluster rule so the expected list is empty.
 */
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { makeKubernetesDriver, type KindDef } from "../shared";

export const networkPolicyDef: KindDef = {
  suffix: "networkpolicy",
  nativeType: "k8s:NetworkPolicy",
  kind: "NetworkPolicy",
  portable: ["firewall"],
  attributes: (live) => {
    const rules = dig(live, "spec", "ingress");
    const list = Array.isArray(rules) ? rules : [];
    const ports = new Set<string>();
    for (const r of list) {
      const rp = isRecord(r) ? r.ports : undefined;
      if (!Array.isArray(rp)) continue;
      for (const p of rp) if (isRecord(p) && typeof p.port === "number") ports.add(`${String(p.protocol ?? "TCP").toLowerCase()}/${p.port}`);
    }
    return { policyTypes: sortedStrings(dig(live, "spec", "policyTypes")), ingressPorts: [...ports].sort(), ingressRules: list.length };
  },
  expected: safeExpected((node) => {
    const s = isRecord(node.spec) ? node.spec : {};
    const out: Record<string, unknown> = { policyTypes: ["Ingress"] };
    if (s.capability === "public_http") return out;
    if (s.crossBoundary !== undefined) out.ingressPorts = [];
    else if (typeof s.port === "number") out.ingressPorts = [`tcp/${s.port}`];
    return out;
  }),
  summary: (live) => compact({ policyTypes: sortedStrings(dig(live, "spec", "policyTypes")).join(",") || undefined }),
};

export const networkPolicyDriver = makeKubernetesDriver(networkPolicyDef);
