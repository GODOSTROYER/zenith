/** Full-graph wiring through the production renderer. Cloud access is not verified live. */
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { exportKubernetesBundle } from "@/lib/providers/zenith/export";
import { dig, type K8sObject, type ToolkitRenderBase } from "@/lib/providers/zenith/k8s-port";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { FakeTlsClient } from "./tls-support";
import { DB, FakeToolkit, NS, TENANT, TYPICAL_GRAPH, WEB, mkNode, session, substrate } from "./support";

const fixtures = [
  { provider: "aws", nativeType: "aws:iam_role", mechanism: "eks-irsa", attribute: "arn", annotation: "eks.amazonaws.com/role-arn", value: "arn:aws:iam::123456789012:role/published-role" },
  { provider: "gcp", nativeType: "gcp:service_account", mechanism: "gke", attribute: "email", annotation: "iam.gke.io/gcp-service-account", value: "published-account@project-alpha.iam.gserviceaccount.com" },
  { provider: "azure", nativeType: "azure:user_assigned_identity", mechanism: "aks", attribute: "client_id", annotation: "azure.workload.identity/client-id", value: "12345678-1234-1234-1234-1234567890ab" },
] as const;

function graph(f = fixtures[0] as typeof fixtures[number]) {
  const target = mkNode("object_store/cloud", "object_store", {}, { provider: f.provider, nativeType: `${f.provider}:bucket` });
  const grants = [{ target: target.address, access: ["read"], via: [] }];
  const identity = mkNode("identity/workload", "identity", { workload: WEB.address, grants });
  const cloud = mkNode("identity/cloud", "identity", { workload: WEB.address, grants }, { provider: f.provider, nativeType: f.nativeType });
  const cluster = mkNode("kubernetes_cluster/cloud", "kubernetes_cluster", {}, { provider: f.provider, nativeType: `${f.provider}:cluster`, ownership: "referenced", externalRef: "existing-cluster" });
  const unrelated = mkNode("postgres/unrelated-kubernetes", "postgres", DB.spec, { provider: "kubernetes", nativeType: "k8s:StatefulSet" });
  const nodes = [...TYPICAL_GRAPH, identity, target, cloud, cluster, unrelated];
  const context: Pick<ToolkitRenderBase, "workloadIdentity" | "resolveAttribute"> = {
    workloadIdentity: { cluster: cluster.address, mechanism: f.mechanism },
    resolveAttribute: (address, attribute) => address === cloud.address && attribute === f.attribute ? f.value : undefined,
  };
  return { nodes, context, target, cloud, cluster, identity };
}
const managed = (g: ReturnType<typeof graph>, context = g.context) => renderZenithEnvironment({
  nodes: g.nodes, tenant: TENANT, substrate: substrate(), toolkit: { renderGraph }, ...context,
});
const exported = (g: ReturnType<typeof graph>, context = g.context) => exportKubernetesBundle({
  nodes: g.nodes, environmentId: TENANT.environmentId, title: "Identity contract", namespace: "portable", toolkit: { renderGraph }, ...context,
});
const manifests = (bundle: ReturnType<typeof exported>) => bundle.files.filter((file) => file.path.startsWith("manifests/")).map((file) => load(file.content) as K8sObject);
const account = (objects: readonly K8sObject[]) => objects.find((object) => object.kind === "ServiceAccount" && object.metadata.name === "workload")!;

describe("Zenith workload identity graph wiring", () => {
  it.each(fixtures)("preserves $mechanism counterpart/cluster/target evidence for managed render and export", (f) => {
    const g = graph(f);
    const original = structuredClone(g.nodes);
    const rendered = managed(g);
    const bundle = exported(g);
    for (const [objects, namespace] of [[rendered.workloads, NS], [manifests(bundle), "portable"]] as const) {
      expect(account(objects).metadata.annotations?.[f.annotation]).toBe(f.value);
      expect(account(objects).automountServiceAccountToken).toBe(false);
      expect(objects.every((object) => object.kind !== "StatefulSet")).toBe(true);
      expect(objects.filter((object) => object.kind !== "Namespace").every((object) => object.metadata.namespace === namespace)).toBe(true);
      const deployment = objects.find((object) => object.kind === "Deployment" && object.metadata.name === "web")!;
      expect(dig(deployment, "spec", "template", "spec", "serviceAccountName")).toBe("workload");
      expect(dig(deployment, "spec", "template", "spec", "automountServiceAccountToken")).toBe(false);
      expect(dig(deployment, "spec", "template", "metadata", "labels", "azure.workload.identity/use")).toBe(f.mechanism === "aks" ? "true" : undefined);
    }
    expect(rendered.notes.join()).toContain("Effective cloud access is unverified");
    expect(bundle.notes.join()).toContain("Effective cloud access is unverified");
    expect(g.nodes).toEqual(original);
    expect(rendered.notes.join()).not.toContain("postgres/db: referenced node");
    expect(bundle.notes.join()).not.toContain("postgres/db: referenced node");
    expect(managed({ ...g, nodes: [...g.nodes].reverse() })).toEqual(rendered);
    expect(exported({ ...g, nodes: [...g.nodes].reverse() })).toEqual(bundle);
  });

  it("passes the identity context through apply before workloads render", async () => {
    const g = graph();
    const toolkit = new FakeToolkit();
    toolkit.renderGraph = renderGraph;
    const report = await applyZenithEnvironment({
      session: session(unavailableDatabaseProvider("No database in this fixture.")), expect: TENANT,
      nodes: g.nodes.filter((node) => node !== DB), toolkit, tlsClient: new FakeTlsClient(),
      resolveSecret: async () => "contract-value", ...g.context,
    });
    expect(report.ok).toBe(true);
    expect(account(toolkit.applyCalls[1].objects).metadata.annotations?.[fixtures[0].annotation]).toBe(fixtures[0].value);
  });

  it.each([undefined, "unknown", "${aws_iam_role.identity.arn}", "secret-canary", { state: "unknown" }])("withholds unresolved or invalid attributes without emitting their values: %j", (value) => {
    const g = graph();
    const context = { ...g.context, resolveAttribute: () => value };
    const rendered = managed(g, context);
    const bundle = exported(g, context);
    for (const objects of [rendered.workloads, manifests(bundle)]) expect(account(objects).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(rendered.notes.join()).toContain("no resolved valid published arn");
    expect(bundle.notes.join()).toContain("no resolved valid published arn");
    expect(JSON.stringify({ rendered, bundle })).not.toContain("secret-canary");
  });

  it("scrubs resolver errors in managed renders and exports", () => {
    const g = graph();
    const context = { ...g.context, resolveAttribute: () => { throw new Error("resolver-secret-canary"); } };
    const rendered = managed(g, context);
    const bundle = exported(g, context);
    expect(JSON.stringify({ rendered, bundle })).not.toContain("resolver-secret-canary");
    expect(account(rendered.workloads).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(account(manifests(bundle)).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
  });

  it.each(["missing", "ambiguous", "wrong-workload", "incomplete-grants", "missing-cluster", "wrong-provider"])("withholds cloud annotations when evidence is %s", (variant) => {
    const g = graph();
    if (variant === "missing") g.nodes = g.nodes.filter((node) => node !== g.cloud);
    if (variant === "ambiguous") g.nodes.push({ ...g.cloud, address: "identity/second-cloud" });
    if (variant === "wrong-workload") g.nodes = g.nodes.map((node) => node === g.cloud ? { ...node, spec: { ...node.spec, workload: "container_service/other" } } : node);
    if (variant === "incomplete-grants") g.nodes = g.nodes.map((node) => node === g.cloud ? { ...node, spec: { ...node.spec, grants: [] } } : node);
    if (variant === "missing-cluster") g.nodes = g.nodes.filter((node) => node !== g.cluster);
    if (variant === "wrong-provider") g.nodes = g.nodes.map((node) => node === g.target ? { ...node, provider: "gcp" } : node);
    const rendered = managed(g);
    const bundle = exported(g);
    expect(account(rendered.workloads).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    expect(account(manifests(bundle)).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
    const reason = variant === "wrong-provider" ? "does not match the cluster's cloud provider; no cloud binding rendered" : "no annotation rendered";
    expect(rendered.notes.join()).toContain(reason);
    expect(bundle.notes.join()).toContain(reason);
  });

  it("reports missing mechanism and Pod Identity prerequisites without guessing annotations", () => {
    const g = graph();
    for (const context of [{ ...g.context, workloadIdentity: undefined }, { ...g.context, workloadIdentity: { cluster: g.cluster.address, mechanism: "eks-pod-identity" as const } }]) {
      const rendered = managed(g, context);
      const bundle = exported(g, context);
      expect(account(rendered.workloads).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
      expect(account(manifests(bundle)).metadata.annotations?.[fixtures[0].annotation]).toBeUndefined();
      expect(rendered.notes.join()).toMatch(/explicit workload-identity mechanism|cloud-side association/);
      expect(bundle.notes.join()).toMatch(/explicit workload-identity mechanism|cloud-side association/);
    }
  });

  it("refuses duplicate graph addresses, including cloud nodes", () => {
    const g = graph();
    g.nodes.push({ ...g.cloud });
    expect(() => managed(g)).toThrow(/duplicate node addresses/);
    expect(() => exported(g)).toThrow(/duplicate node addresses/);
  });
});
