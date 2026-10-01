/** Pure grant rendering contracts. Cloud fixtures are not live cloud evidence. */
import { describe, expect, it } from "vitest";
import { renderGraph, renderNode } from "@/lib/providers/kubernetes/render";
import { objectName, secretObjectName } from "@/lib/providers/kubernetes/naming";
import { ANNOTATION, LABEL, type K8sObject, type K8sRenderContext } from "@/lib/providers/kubernetes/types";
import { dig } from "@/lib/providers/kubernetes/util";
import { ENV_ID, NS, cronNode, ctxFor, networkNode, node, secretNode, serviceNode } from "./helpers";

const identity = (grants: unknown, workload = "service/web") => node({
  address: "identity/web", kind: "identity", spec: { namespace: NS, principal: "workload", workload, grants },
});
const grant = (target: string, access = ["read"]) => ({ target, access, via: ["fixture"] });
const find = (objects: K8sObject[], kind: string) => objects.find((o) => o.kind === kind)!;
const configMap = () => node({ address: "config/settings", kind: "provider_native", nativeType: "k8s:ConfigMap", ownership: "referenced", externalRef: `${NS}/settings.conf`, spec: {} });
const rbacGraph = () => [networkNode(), serviceNode(), secretNode(), configMap(), identity([grant("secret/stripe-key"), grant("config/settings", ["patch", "get"])])];

describe("identity namespaced RBAC", () => {
  it("pins independent rules to exact Secret/ConfigMap names and requested verbs", () => {
    const graph = rbacGraph();
    const { objects } = renderGraph(graph, { environmentId: ENV_ID });
    const role = find(objects, "Role");
    expect(role.metadata.namespace).toBe(NS);
    expect(role.rules).toEqual([
      { apiGroups: [""], resources: ["configmaps"], resourceNames: ["settings.conf"], verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["secrets"], resourceNames: [secretObjectName("vault:proj1/svc1/STRIPE_KEY")], verbs: ["get"] },
    ]);
    expect(find(objects, "RoleBinding")).toMatchObject({
      apiVersion: "rbac.authorization.k8s.io/v1", metadata: { namespace: NS },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name },
      subjects: [{ kind: "ServiceAccount", namespace: NS, name: "web" }],
    });
    for (const o of objects.filter((o) => ["Role", "RoleBinding"].includes(o.kind))) {
      expect(o.metadata.labels?.[LABEL.managedBy]).toBe("zenith");
      expect(o.metadata.annotations?.[ANNOTATION.environment]).toBe(ENV_ID);
      expect(o.metadata.annotations?.[ANNOTATION.resource]).toBe("identity/web");
      expect(JSON.stringify(o)).not.toContain('"*"');
    }
    expect(objects.some((o) => o.kind.startsWith("ClusterRole"))).toBe(false);
    expect(objects.map((o) => o.kind).indexOf("RoleBinding")).toBeLessThan(objects.map((o) => o.kind).indexOf("Deployment"));
  });

  it("enables an API token only on the identity and workload with rendered RBAC", () => {
    const graph = [...rbacGraph(), serviceNode({}, "service/other")];
    const { objects } = renderGraph(graph, { environmentId: ENV_ID });
    expect(find(objects, "ServiceAccount").automountServiceAccountToken).toBe(true);
    const deployments = objects.filter((o) => o.kind === "Deployment");
    const web = deployments.find((o) => o.metadata.name === "web")!;
    expect(dig(web, "spec", "template", "spec", "automountServiceAccountToken")).toBe(true);
    expect(dig(web, "spec", "template", "spec", "serviceAccountName")).toBe("web");
    const other = deployments.find((o) => o.metadata.name === "other")!;
    expect(dig(other, "spec", "template", "spec", "automountServiceAccountToken")).toBe(false);
  });

  it("binds a target in a different namespace to the explicit ServiceAccount namespace", () => {
    const target = { ...secretNode(), spec: { ...secretNode().spec, namespace: "data" } };
    const graph = [target, identity([grant(target.address)])];
    const { objects } = renderNode(graph[1], ctxFor(graph));
    expect(find(objects, "Role").metadata.namespace).toBe("data");
    expect(find(objects, "RoleBinding").subjects).toEqual([{ kind: "ServiceAccount", name: "web", namespace: NS }]);
  });

  it("keeps API groups and plurals exact for non-core objects", () => {
    const target = serviceNode();
    const graph = [networkNode(), target, identity([grant(target.address, ["watch", "list", "get"])])];
    const r = renderNode(graph[2], ctxFor(graph));
    expect(find(r.objects, "Role").rules).toEqual([{ apiGroups: ["apps"], resources: ["deployments"], resourceNames: ["web"], verbs: ["get", "list", "watch"] }]);
    expect(r.notes.join()).toMatch(/metadata.name field selector/);
  });

  it("deduplicates rules and is deterministic under node/grant/verb reordering", () => {
    const graph = rbacGraph();
    const first = renderGraph(graph, { environmentId: ENV_ID });
    const reordered = [...graph].reverse().map((n) => n.kind === "identity" ? { ...identity([
      grant("config/settings", ["get", "patch", "get"]), grant("secret/stripe-key"), grant("secret/stripe-key"),
    ]), specDigest: n.specDigest } : n); // hold the caller-supplied digest fixed when comparing compilation
    expect(renderGraph(reordered, { environmentId: ENV_ID })).toEqual(first);
  });

  it.each(["*", "get*", "create", "deletecollection", "bind", "escalate", "impersonate", "not_a_verb"])("refuses unsafe or unsupported verb %s", (verb) => {
    const target = secretNode();
    const id = identity([grant(target.address, [verb])]);
    expect(() => renderNode(id, ctxFor([target, id]))).toThrow();
  });

  it.each([null, {}, "grants", [{ target: "*", access: ["get"] }], [{ target: "secret/foo", access: [] }], [{ target: "secret/foo", access: [null] }]])("refuses malformed grants %j", (grants) => {
    expect(() => renderNode(identity(grants), ctxFor([]))).toThrow(/grants|grant/);
  });

  it("renders no RBAC for missing, cluster-scoped or data-plane targets and says why", () => {
    const clusterScope = node({ address: "network/main", kind: "network", spec: { namespace: NS } });
    const db = node({ address: "resource/db", kind: "postgres", spec: {} });
    const id = identity([grant("missing/target"), grant(clusterScope.address, ["get"]), grant(db.address, ["connect"])]);
    const r = renderNode(id, ctxFor([clusterScope, db, id]));
    expect(r.objects.map((o) => o.kind)).toEqual(["ServiceAccount"]);
    expect(find(r.objects, "ServiceAccount").automountServiceAccountToken).toBe(false);
    expect(r.notes.join()).toMatch(/missing from the graph/);
    expect(r.notes.join()).toMatch(/no supported namespaced/);
    expect(r.notes.join()).toMatch(/data-plane/);
  });

  it("never guesses the name of a foreign object", () => {
    const target = { ...configMap(), externalRef: undefined };
    const id = identity([grant(target.address)]);
    const r = renderNode(id, ctxFor([target, id]));
    expect(r.objects).toHaveLength(1);
    expect(r.notes.join()).toMatch(/no explicit or rendered object location/);
  });

  it.each(["shop/*", "shop/../secret", "*/secret"])("refuses malformed external object location %s", (externalRef) => {
    const target = { ...configMap(), externalRef };
    const id = identity([grant(target.address)]);
    expect(() => renderNode(id, ctxFor([target, id]))).toThrow(/valid namespace\/name/);
  });

  it("refuses duplicate graph addresses and ambiguous or misplaced workload identities", () => {
    const id = identity([]);
    expect(() => renderGraph([id, id], { environmentId: ENV_ID })).toThrow(/duplicate/);
    expect(() => renderGraph([serviceNode(), id, { ...id, address: "identity/other" }], { environmentId: ENV_ID })).toThrow(/several/);
    expect(() => renderGraph([serviceNode({ namespace: "other" }), id], { environmentId: ENV_ID })).toThrow(/workload namespace/);
  });
});

type Mechanism = NonNullable<K8sRenderContext["workloadIdentity"]>["mechanism"];
const fixtures = [
  { provider: "aws", nativeType: "aws:iam_role", mechanism: "eks-irsa", attribute: "arn", annotation: "eks.amazonaws.com/role-arn", value: "arn:aws:iam::123456789012:role/a-published-role" },
  { provider: "gcp", nativeType: "gcp:service_account", mechanism: "gke", attribute: "email", annotation: "iam.gke.io/gcp-service-account", value: "published-account@project-alpha.iam.gserviceaccount.com" },
  { provider: "azure", nativeType: "azure:user_assigned_identity", mechanism: "aks", attribute: "client_id", annotation: "azure.workload.identity/client-id", value: "12345678-1234-1234-1234-1234567890ab" },
] as const;

function cloudGraph(f: typeof fixtures[number], workload = serviceNode()) {
  const target = node({ address: "resource/bucket", kind: "object_store", provider: f.provider, nativeType: `${f.provider}:bucket`, spec: {} });
  const id = identity([grant(target.address)], workload.address);
  const cloud = node({ address: "identity/explicit-cloud-counterpart", kind: "identity", provider: f.provider, nativeType: f.nativeType, spec: { workload: workload.address, grants: [grant(target.address)] } });
  const cluster = node({ address: "cluster/main", kind: "kubernetes_cluster", provider: f.provider, nativeType: `${f.provider}:cluster`, ownership: "referenced", externalRef: "explicit-existing-cluster", spec: {} });
  const nodes = [networkNode(), workload, target, id, cloud, cluster];
  const resolveAttribute = (address: string, attribute: string) => address === cloud.address && attribute === f.attribute ? f.value : undefined;
  const base: Omit<K8sRenderContext, "node" | "nodes" | "namespace"> = { environmentId: ENV_ID, workloadIdentity: { cluster: cluster.address, mechanism: f.mechanism }, resolveAttribute };
  return { nodes, id, cloud, cluster, target, base };
}

describe("cloud workload identity annotations", () => {
  it.each(fixtures)("uses only the published $attribute for $mechanism", (f) => {
    const { nodes, base, cloud } = cloudGraph(f);
    const calls: string[][] = [];
    const r = renderGraph(nodes, { ...base, resolveAttribute: (a, key) => { calls.push([a, key]); return base.resolveAttribute?.(a, key); } });
    const sa = find(r.objects, "ServiceAccount");
    expect(sa.metadata.annotations?.[f.annotation]).toBe(f.value);
    expect(calls.every(([a, key]) => a === cloud.address && key === f.attribute)).toBe(true);
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(r.objects.some((o) => o.kind === "Role")).toBe(false);
    expect(r.notes.join()).toMatch(/Effective cloud access is unverified/);
    const pod = dig(find(r.objects, "Deployment"), "spec", "template");
    expect(dig(pod, "metadata", "labels", "azure.workload.identity/use")).toBe(f.mechanism === "aks" ? "true" : undefined);
    expect(dig(pod, "spec", "automountServiceAccountToken")).toBe(false);
  });

  it("labels AKS CronJob pod templates as well as Deployments", () => {
    const { nodes, base } = cloudGraph(fixtures[2], cronNode());
    const r = renderGraph(nodes, base);
    expect(dig(find(r.objects, "CronJob"), "spec", "jobTemplate", "spec", "template", "metadata", "labels", "azure.workload.identity/use")).toBe("true");
  });

  it.each(fixtures)("notes a missing $provider identity and invents no annotation", (f) => {
    const { nodes, base, cloud } = cloudGraph(f);
    const r = renderGraph(nodes.filter((n) => n !== cloud), base);
    expect(find(r.objects, "ServiceAccount").metadata.annotations?.[f.annotation]).toBeUndefined();
    expect(r.notes.join()).toMatch(/missing cloud identity/);
    expect(dig(find(r.objects, "Deployment"), "spec", "template", "metadata", "labels", "azure.workload.identity/use")).toBeUndefined();
  });

  it.each([undefined, "${local.identity_arn}", "unknown", "secret-value", { state: "unknown" }])("does not render unresolved/invalid published values %j", (value) => {
    const { nodes, base } = cloudGraph(fixtures[0]);
    const r = renderGraph(nodes, { ...base, resolveAttribute: () => value });
    expect(find(r.objects, "ServiceAccount").metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(r.notes.join()).toMatch(/no resolved valid published arn/);
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("does not disclose errors from the attribute resolver", () => {
    const { nodes, base } = cloudGraph(fixtures[0]);
    const r = renderGraph(nodes, { ...base, resolveAttribute: () => { throw new Error("resolver-secret-canary"); } });
    expect(JSON.stringify(r)).not.toContain("resolver-secret-canary");
    expect(r.notes.join()).toMatch(/no resolved valid/);
  });

  it("refuses ambiguous counterparts, mismatched workloads, or incomplete cloud grants", () => {
    const f = fixtures[0];
    const { nodes, base, cloud } = cloudGraph(f);
    const duplicate = { ...cloud, address: "identity/second" };
    expect(renderGraph([...nodes, duplicate], base).notes.join()).toMatch(/ambiguous cloud identity/);
    for (const spec of [{ ...cloud.spec, workload: "service/other" }, { ...cloud.spec, grants: [grant("resource/elsewhere")] }, { ...cloud.spec, grants: [grant("resource/bucket", ["write"])] }]) {
      const r = renderGraph(nodes.map((n) => n === cloud ? { ...cloud, spec } : n), base);
      expect(find(r.objects, "ServiceAccount").metadata.annotations?.[f.annotation]).toBeUndefined();
      expect(r.notes.join()).toMatch(/missing cloud identity/);
    }
  });

  it("requires a graph cluster and an explicit matching mechanism", () => {
    const { nodes, base, cluster } = cloudGraph(fixtures[0]);
    for (const [graph, config] of [[nodes.filter((n) => n !== cluster), base], [nodes, { ...base, workloadIdentity: undefined }], [nodes, { ...base, workloadIdentity: { cluster: cluster.address, mechanism: "gke" as Mechanism } }]] as const) {
      const r = renderGraph(graph, config);
      expect(find(r.objects, "ServiceAccount").metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
      expect(r.notes.join()).toMatch(/explicit workload-identity mechanism/);
    }
  });

  it("leaves cross-cloud grants unbound and says why", () => {
    const { nodes, base, target } = cloudGraph(fixtures[0]);
    const r = renderGraph(nodes.map((n) => n === target ? { ...target, provider: "gcp" as const } : n), base);
    expect(find(r.objects, "ServiceAccount").metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(r.notes.join()).toMatch(/does not match the cluster's cloud provider/);
  });

  it("honestly reports the cloud-side EKS Pod Identity association prerequisite", () => {
    const { nodes, base } = cloudGraph(fixtures[0]);
    const r = renderGraph(nodes, { ...base, workloadIdentity: { cluster: "cluster/main", mechanism: "eks-pod-identity" } });
    expect(find(r.objects, "ServiceAccount").metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(r.notes.join()).toMatch(/cloud-side association/);
    expect(r.notes.join()).toMatch(/does not create the association/);
    expect(objectName(nodes.find((n) => n.address === "identity/web")!)).toBe("web");
  });
});
