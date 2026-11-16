/**
 * `k8s:Ingress` — load_balancer.
 *
 * `loadBalancerAddress` is read from `status.loadBalancer` and is what a DNS
 * record should point at; it is reported, not compared (no desired value).
 * Whether an ingress controller is installed and serving this class is a
 * cluster prerequisite Zenith does not check.
 */
import type { LoadBalancerSpec } from "@/lib/resources/specs";
import { attributeCheck, makeKubernetesDriver, type KindDef } from "../shared";
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { ingressRuntime } from "../runtime";

export function ingressAddress(live: Record<string, unknown>): string | undefined {
  const first = dig(live, "status", "loadBalancer", "ingress", 0);
  if (!isRecord(first)) return undefined;
  const v = first.hostname ?? first.ip;
  return typeof v === "string" && v !== "" ? v : undefined;
}

export const ingressDef: KindDef = {
  suffix: "ingress",
  nativeType: "k8s:Ingress",
  kind: "Ingress",
  portable: ["load_balancer"],
  attributes: (live) => {
    const rules = dig(live, "spec", "rules");
    const tls = dig(live, "spec", "tls");
    return {
      ingressClass: dig(live, "spec", "ingressClassName"),
      hosts: sortedStrings((Array.isArray(rules) ? rules : []).map((r) => (isRecord(r) ? r.host : undefined))),
      tlsHosts: sortedStrings((Array.isArray(tls) ? tls : []).flatMap((t) => (isRecord(t) && Array.isArray(t.hosts) ? t.hosts : []))),
      loadBalancerAddress: ingressAddress(live) ?? null,
    };
  },
  expected: safeExpected((node) => {
    const s = node.spec as unknown as Partial<LoadBalancerSpec>;
    const routes = Array.isArray(s.routes) ? s.routes : [];
    return {
      ...(typeof s.ingressClass === "string" ? { ingressClass: s.ingressClass } : {}),
      hosts: sortedStrings(routes.map((r) => r.host)),
      tlsHosts: sortedStrings(routes.filter((r) => r.tls === true).map((r) => r.host)),
    };
  }),
  summary: (live) => compact({ ingressClass: dig(live, "spec", "ingressClassName"), address: ingressAddress(live) }),
  runtime: ingressRuntime,
  extraChecks: (_node, observation) => [
    attributeCheck(observation, "loadBalancerAddress", "address_assigned", "the ingress has been given an address", (v) => typeof v === "string" && v !== ""),
  ],
};

export const ingressDriver = makeKubernetesDriver(ingressDef);
