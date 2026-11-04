/**
 * `k8s:Namespace` — network and kubernetes_namespace (the network IS the namespace).
 *
 * The expected `name` is only known when the spec names the namespace; with the
 * environment default it depends on the environment id, which
 * `expectedAttributes(node)` does not receive, so only the Pod Security label
 * is compared then.
 */
import { dig, isRecord } from "../../util";
import { compact, labelsOf, safeExpected } from "../attrs";
import { namespaceRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";

const PSA_ENFORCE = "pod-security.kubernetes.io/enforce";

export const namespaceDef: KindDef = {
  suffix: "namespace",
  nativeType: "k8s:Namespace",
  kind: "Namespace",
  portable: ["network", "kubernetes_namespace"],
  attributes: (live) => ({ name: dig(live, "metadata", "name"), podSecurityEnforce: labelsOf(live)[PSA_ENFORCE] }),
  expected: safeExpected((node) => {
    const s = isRecord(node.spec) ? node.spec : {};
    const ns = s.namespace ?? s.name;
    return { ...(typeof ns === "string" && ns !== "" ? { name: ns } : {}), podSecurityEnforce: "baseline" };
  }),
  summary: (live) => compact({ phase: dig(live, "status", "phase") }),
  runtime: namespaceRuntime,
};

export const namespaceDriver = makeKubernetesDriver(namespaceDef);
