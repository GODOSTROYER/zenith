/**
 * `k8s:NetworkPolicy` — firewall.
 *
 * Observed: which policy types apply and which TCP ports the ingress rules
 * open. Whether the CNI actually ENFORCES NetworkPolicy is a cluster property.
 * Runtime reads the node agents (`cni.ts`) and reports `engine:<name>` when a
 * known policy engine is installed, or `enforcement_unverified` when none was
 * recognised or the agents are outside the session's namespaces. It never says
 * "not enforcing". A passing verify means the policy object is present and
 * shaped as desired; the `enforcing_cni` check is added only when an enforcing
 * engine was detected. Traffic-level proof is the acceptance harness's job.
 *
 * `ingressPorts` is expected only when the desired rule is expressible inside
 * the cluster: a public_http rule (target is a load balancer whose backend
 * ports depend on the graph) omits it, and a cross-boundary source has no
 * in-cluster rule so the expected list is empty.
 */
import type { VerificationCheck } from "@/lib/drivers/types";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { detectPolicyEngine } from "../../cni";
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { makeKubernetesDriver, type KindDef } from "../shared";

function enforcementChecks(_node: ResourceNode, _observation: Observation, runtime?: RuntimeState): VerificationCheck[] {
  if (runtime?.counts.enforcing !== 1) return [];
  const engine = runtime.signals.find((s) => s.startsWith("engine:"))?.slice("engine:".length);
  return [{ id: "enforcing_cni", description: "the cluster runs a NetworkPolicy engine", passed: true, detail: engine }];
}

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
  runtime: async ({ client, live }) => {
    const reading = await detectPolicyEngine(client);
    const rules = (key: "ingress" | "egress") => {
      const r = dig(live, "spec", key);
      return Array.isArray(r) ? r.length : 0;
    };
    const signals = reading.enforcing ? [`engine:${reading.engine}`] : [reading.readable ? "enforcement_unverified" : "cni_unreadable"];
    return {
      health: reading.enforcing ? "healthy" : "unknown",
      counts: { enforcing: reading.enforcing ? 1 : 0, ingress_rules: rules("ingress"), egress_rules: rules("egress") },
      signals,
    };
  },
  extraChecks: enforcementChecks,
};

export const networkPolicyDriver = makeKubernetesDriver(networkPolicyDef);
