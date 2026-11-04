/**
 * Which NetworkPolicy engine a cluster runs, read from its node agents.
 *
 * A NetworkPolicy object means nothing unless a CNI plugin enforces it: on a
 * cluster whose plugin ignores policies the API accepts every object and every
 * packet still flows. Detection here is evidence, not proof. It recognises the
 * agents of engines that implement NetworkPolicy and reports "enforcing" only
 * for those; anything else is "unverified", never "not enforcing" (some default
 * plugins enforce, some do not, and the DaemonSet name cannot tell). The proof
 * that matters is real traffic against a deny rule, which the acceptance harness
 * (`tests/providers/kubernetes/lifecycle-acceptance.test.ts`) performs.
 *
 * The scan reads DaemonSets in the namespaces where these agents live and goes
 * through the namespace guard like every other namespaced read, so a session
 * whose allowlist excludes them reports `unreadable` instead of reaching out of
 * its scope. Add the namespaces to the connection allowlist to enable detection.
 */
import { READ_ONLY_KINDS, listByKind, type K8sClient } from "./client";
import { dig, isRecord } from "./util";

/** Namespaces where policy-engine agents are installed. */
export const CNI_NAMESPACES = ["kube-system", "calico-system"] as const;

interface Signature {
  engine: string;
  /** DaemonSet name */
  daemonSet: string;
  /** when set, a container of this name must exist in the pod template (the agent is optional in the DaemonSet) */
  container?: readonly string[];
}

/** Agents of engines that implement NetworkPolicy. */
const ENFORCING: readonly Signature[] = [
  { engine: "calico", daemonSet: "calico-node" },
  { engine: "calico", daemonSet: "canal" },
  { engine: "cilium", daemonSet: "cilium" },
  { engine: "gke-dataplane-v2", daemonSet: "anetd" },
  { engine: "antrea", daemonSet: "antrea-agent" },
  { engine: "azure-npm", daemonSet: "azure-npm" },
  { engine: "kube-router", daemonSet: "kube-router" },
  { engine: "weave-npc", daemonSet: "weave-net" },
  // EKS: the VPC CNI only enforces when its policy agent container is present.
  { engine: "aws-vpc-cni-network-policy", daemonSet: "aws-node", container: ["aws-eks-nodeagent", "aws-network-policy-agent"] },
];

export interface PolicyEngineReading {
  /** an engine known to implement NetworkPolicy was found */
  enforcing: boolean;
  engine?: string;
  /** DaemonSet names that were recognised (never free text from the cluster) */
  evidence: string[];
  /** false when no listed namespace could be read; the answer is then "unreadable", not "none" */
  readable: boolean;
}

function containersOf(ds: Record<string, unknown>): string[] {
  const list = dig(ds, "spec", "template", "spec", "containers");
  return Array.isArray(list) ? list.map((c) => (isRecord(c) && typeof c.name === "string" ? c.name : "")).filter(Boolean) : [];
}

export async function detectPolicyEngine(client: K8sClient): Promise<PolicyEngineReading> {
  const found: { engine: string; name: string }[] = [];
  const seen = new Set<string>();
  let readable = false;
  for (const ns of CNI_NAMESPACES) {
    try {
      await client.guard.assert(ns);
      const listing = await listByKind(client, READ_ONLY_KINDS.DaemonSet, ns, { limit: 200, maxPages: 1 });
      readable = true;
      for (const ds of listing.items) {
        const name = dig(ds, "metadata", "name");
        if (typeof name !== "string") continue;
        const sig = ENFORCING.find((s) => s.daemonSet === name);
        if (sig) {
          if (sig.container && !containersOf(ds).some((c) => sig.container!.includes(c))) continue;
          if (!seen.has(`${sig.engine}/${name}`)) {
            seen.add(`${sig.engine}/${name}`);
            found.push({ engine: sig.engine, name });
          }
        }
      }
    } catch {
      // outside the allowlist, forbidden or not served: this namespace contributes nothing
    }
  }
  const engines = [...new Set(found.map((f) => f.engine))].sort();
  return {
    enforcing: found.length > 0,
    ...(engines.length > 0 ? { engine: engines.join("+") } : {}),
    evidence: found.map((f) => f.name).sort(),
    readable,
  };
}
