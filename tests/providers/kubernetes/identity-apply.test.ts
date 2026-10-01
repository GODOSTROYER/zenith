/** Fake HTTP contracts for identity apply/prune; the fake does not enforce RBAC. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diff, pruneOrphans, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { serviceAccountDriver } from "@/lib/providers/kubernetes/drivers/identity/serviceaccount";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { ANNOTATION, LABEL, type K8sObject } from "@/lib/providers/kubernetes/types";
import { dig, plain } from "@/lib/providers/kubernetes/util";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, driverCtx, networkNode, node, secretNode, serviceNode, sessionFor } from "./helpers";

let fake: FakeK8s;
beforeEach(async () => { fake = await startFakeK8s(); });
afterEach(async () => { await fake.close(); });
const id = (grants = [{ target: "secret/stripe-key", access: ["read"], via: [] }]) => node({ address: "identity/web", kind: "identity", dependsOn: ["network/main"], spec: { namespace: NS, workload: "service/web", grants } });
const desired = (identity = id()) => renderGraph([networkNode(), serviceNode(), secretNode(), identity], { environmentId: ENV_ID }).objects;
const find = (objects: K8sObject[], kind: string) => objects.find((o) => o.kind === kind)!;
const patches = () => fake.requests.filter((r) => r.method === "PATCH");
const apply = async (objects: K8sObject[]) => serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID, resolveSecret: async () => "test-value" });

const cloudFixtures = [
  { provider: "aws", nativeType: "aws:iam_role", mechanism: "eks-irsa", attribute: "arn", annotation: "eks.amazonaws.com/role-arn", value: "arn:aws:iam::123456789012:role/published-role" },
  { provider: "gcp", nativeType: "gcp:service_account", mechanism: "gke", attribute: "email", annotation: "iam.gke.io/gcp-service-account", value: "published-account@project-alpha.iam.gserviceaccount.com" },
  { provider: "azure", nativeType: "azure:user_assigned_identity", mechanism: "aks", attribute: "client_id", annotation: "azure.workload.identity/client-id", value: "12345678-1234-1234-1234-1234567890ab" },
] as const;

describe("identity apply and prune contracts", () => {
  it.each(cloudFixtures)("applies and revokes $mechanism annotations from graph fixtures", async (f) => {
    const grants = [{ target: "resource/cloud", access: ["read"], via: [] }];
    const account = id(grants);
    const cloud = node({ address: "identity/published-counterpart", kind: "identity", provider: f.provider, nativeType: f.nativeType, spec: { workload: "service/web", grants } });
    const target = node({ address: "resource/cloud", kind: "object_store", provider: f.provider, nativeType: `${f.provider}:bucket`, spec: {} });
    const cluster = node({ address: "cluster/main", kind: "kubernetes_cluster", provider: f.provider, nativeType: `${f.provider}:cluster`, ownership: "referenced", spec: {} });
    const nodes = [networkNode(), serviceNode({ env: [] }), account, target, cluster, cloud];
    const context = { environmentId: ENV_ID, workloadIdentity: { cluster: cluster.address, mechanism: f.mechanism }, resolveAttribute: (a: string, key: string) => a === cloud.address && key === f.attribute ? f.value : undefined };
    const first = renderGraph(nodes, context);
    expect((await apply(first.objects)).ok).toBe(true);
    expect(dig(fake.get("ServiceAccount", NS, "web"), "metadata", "annotations", f.annotation)).toBe(f.value);
    const sent = patches().find((q) => q.body?.kind === "ServiceAccount")!;
    expect(dig(sent.body, "metadata", "annotations", f.annotation)).toBe(f.value);
    expect(dig(fake.get("Deployment", NS, "web"), "spec", "template", "metadata", "labels", "azure.workload.identity/use")).toBe(f.mechanism === "aks" ? "true" : undefined);

    const revoked = renderGraph(nodes.filter((n) => n !== cloud), context);
    expect(revoked.notes.join()).toMatch(/missing cloud identity/);
    expect((await apply(revoked.objects)).ok).toBe(true);
    expect(dig(fake.get("ServiceAccount", NS, "web"), "metadata", "annotations", f.annotation)).toBeUndefined();
    expect(dig(fake.get("Deployment", NS, "web"), "spec", "template", "metadata", "labels", "azure.workload.identity/use")).toBeUndefined();
  });

  it("applies exact rules and subjects with zenith/force=false, then is unchanged", async () => {
    const objects = desired();
    const first = await apply([...objects].reverse());
    expect(first.ok).toBe(true);
    expect(first.results).toHaveLength(objects.length);
    expect(first.results.every((r) => r.status === "created")).toBe(true);
    for (const kind of ["Role", "RoleBinding"]) {
      const sent = patches().find((r) => r.body?.kind === kind)!;
      expect(sent.query).toMatchObject({ fieldManager: "zenith", force: "false" });
      expect(sent.body).toEqual(find(objects, kind));
      const live = fake.get(kind, NS, find(objects, kind).metadata.name);
      expect(dig(live, kind === "Role" ? "rules" : "subjects")).toEqual(find(objects, kind)[kind === "Role" ? "rules" : "subjects"]);
    }
    expect((await apply(objects)).results.every((r) => r.status === "unchanged")).toBe(true);
    const changes = await diff(objects, await sessionFor(fake, []), { environmentId: ENV_ID, resolveSecret: async () => "test-value" });
    expect(changes.every((c) => c.action === "none")).toBe(true);
  });

  it.each(["Role", "RoleBinding"])("refuses the entire batch when %s is foreign", async (kind) => {
    const objects = desired();
    const foreign = plain<K8sObject>(find(objects, kind));
    foreign.metadata.labels = { [LABEL.managedBy]: "helm" };
    fake.seed(foreign);
    const result = await apply(objects);
    expect(result.refused).toBe(true);
    expect(result.results).toContainEqual(expect.objectContaining({ status: "ownership_conflict", ref: expect.objectContaining({ kind }) }));
    expect(patches()).toHaveLength(0);
  });

  it("reports an RBAC field-manager conflict without forcing it", async () => {
    const objects = desired();
    const role = plain<K8sObject>(find(objects, "Role"));
    role.rules = [{ apiGroups: [""], resources: ["secrets"], resourceNames: ["different-secret"], verbs: ["get"] }];
    fake.seed(role, "other-manager");
    const r = await apply(objects);
    expect(r.results).toContainEqual(expect.objectContaining({ status: "conflict", ref: expect.objectContaining({ kind: "Role" }) }));
    expect(patches().every((q) => q.query.force === "false")).toBe(true);
    expect(r.results).toContainEqual(expect.objectContaining({ status: "skipped", ref: expect.objectContaining({ kind: "RoleBinding" }) }));
    expect(fake.get("RoleBinding", NS, find(objects, "RoleBinding").metadata.name)).toBeUndefined();
    expect(patches().some((q) => q.body?.kind === "RoleBinding")).toBe(false);
  });

  it("removes revoked verbs from the Role and disables API tokens when no grants remain", async () => {
    const broad = desired(id([{ target: "secret/stripe-key", access: ["get", "patch"], via: [] }]));
    expect((await apply(broad)).ok).toBe(true);
    const narrow = desired(id());
    expect((await apply(narrow)).ok).toBe(true);
    expect(dig(fake.get("Role", NS, find(narrow, "Role").metadata.name), "rules")).toEqual(find(narrow, "Role").rules);
    expect(JSON.stringify(dig(fake.get("Role", NS, find(narrow, "Role").metadata.name), "rules"))).not.toContain("patch");
    expect((await apply(desired(id([])))).ok).toBe(true);
    expect(dig(fake.get("ServiceAccount", NS, "web"), "automountServiceAccountToken")).toBe(false);
    expect(dig(fake.get("Deployment", NS, "web"), "spec", "template", "spec", "automountServiceAccountToken")).toBe(false);
  });

  it.each([
    { resources: ["*"] }, { verbs: ["*"] }, { apiGroups: ["*"] }, { resourceNames: [] },
    { resourceNames: ["*"] }, { verbs: ["create"] }, { verbs: ["deletecollection"] },
    { nonResourceURLs: ["/healthz"] }, { resources: ["secrets", "configmaps"] },
  ])("rejects broad/non-name-restrictable rules before any API write: %j", async (change) => {
    const objects = desired();
    const role = find(objects, "Role");
    role.rules = [{ apiGroups: [""], resources: ["secrets"], resourceNames: ["exact"], verbs: ["get"], ...change }];
    const r = await apply(objects);
    expect(r.refused).toBe(true);
    expect(r.results).toContainEqual(expect.objectContaining({ errorCode: "invalid_object", ref: expect.objectContaining({ kind: "Role" }) }));
    expect(patches()).toHaveLength(0);
  });

  it.each(["ClusterRole", "User", "missing-role", "missing-account", "other-owner"])("refuses binding to an unverified %s", async (mode) => {
    let objects = desired();
    const binding = find(objects, "RoleBinding");
    if (mode === "ClusterRole") binding.roleRef = { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "admin" };
    if (mode === "User") binding.subjects = [{ kind: "User", name: "arbitrary-user" }];
    if (mode === "missing-role") objects = objects.filter((o) => o.kind !== "Role");
    if (mode === "missing-account") objects = objects.filter((o) => o.kind !== "ServiceAccount");
    if (mode === "other-owner") find(objects, "Role").metadata.annotations![ANNOTATION.resource] = "identity/other";
    expect((await apply(objects)).refused).toBe(true);
    expect(patches()).toHaveLength(0);
  });

  it("removes stale RBAC only for this environment, binding before role", async () => {
    const old = desired();
    expect((await apply(old)).ok).toBe(true);
    for (const kind of ["Role", "RoleBinding"]) {
      for (const [name, labels, annotations] of [
        ["helm-owned", { [LABEL.managedBy]: "helm" }, { [ANNOTATION.environment]: ENV_ID }],
        ["other-environment", { [LABEL.managedBy]: "zenith" }, { [ANNOTATION.environment]: OTHER_ENV }],
        ["no-annotation", { [LABEL.managedBy]: "zenith" }, {}],
      ] as const) {
        const foreign = plain<K8sObject>(find(old, kind));
        foreign.metadata = { name, namespace: NS, labels, annotations };
        fake.seed(foreign);
      }
    }
    const current = desired(id([]));
    expect((await apply(current)).ok).toBe(true);
    const result = await pruneOrphans({ desired: current, namespaces: [NS], environmentId: ENV_ID }, await sessionFor(fake, []));
    expect(result.failed).toEqual([]);
    expect(result.deleted.map((r) => r.kind).sort()).toEqual(["Role", "RoleBinding"]);
    for (const kind of ["Role", "RoleBinding"]) {
      expect(fake.get(kind, NS, find(old, kind).metadata.name)).toBeUndefined();
      for (const name of ["helm-owned", "other-environment", "no-annotation"]) expect(fake.get(kind, NS, name)).toBeDefined();
    }
    expect(fake.requests.filter((q) => q.method === "DELETE").map((q) => q.path.split("/").at(-2))).toEqual(["rolebindings", "roles"]);
  });

  it("does not prune RBAC in dry-run", async () => {
    const old = desired();
    expect((await apply(old)).ok).toBe(true);
    const current = desired(id([]));
    const session = await sessionFor(fake, []);
    const preview = await pruneOrphans({ desired: current, namespaces: [NS], environmentId: ENV_ID, dryRun: true }, session);
    expect(preview.deleted.map((r) => r.kind).sort()).toEqual(["Role", "RoleBinding"]);
    expect(fake.requests.filter((q) => q.method === "DELETE")).toHaveLength(0);
  });

  it.each(["Role", "RoleBinding"])("leaves %s alone when ownership changes before the delete re-read", async (kind) => {
    const old = desired();
    expect((await apply(old)).ok).toBe(true);
    const object = find(old, kind);
    let changed = false;
    fake.inject({ match: (req) => {
      if (!changed && req.method === "GET" && req.path.endsWith(`/${kind === "Role" ? "roles" : "rolebindings"}/${object.metadata.name}`)) {
        changed = true;
        fake.foreignUpdate(kind, NS, object.metadata.name, "helm", { metadata: { labels: { [LABEL.managedBy]: "helm" } } });
      }
      return false;
    }, status: 200, message: "" });
    const r = await pruneOrphans({ desired: desired(id([])), namespaces: [NS], environmentId: ENV_ID }, await sessionFor(fake, []));
    expect(changed).toBe(true);
    expect(r.failed).toContainEqual(expect.objectContaining({ code: "ownership_conflict", ref: expect.objectContaining({ kind }) }));
    expect(fake.get(kind, NS, object.metadata.name)).toBeDefined();
    expect(fake.requests.filter((q) => q.method === "DELETE" && q.path.endsWith(`/${object.metadata.name}`) && q.path.includes(`/${kind === "Role" ? "roles" : "rolebindings"}/`))).toHaveLength(0);
  });

  it.each(["Role", "RoleBinding"])("preserves %s replaced after the re-read via uid preconditions", async (kind) => {
    const old = desired();
    expect((await apply(old)).ok).toBe(true);
    const object = find(old, kind);
    let changed = false;
    fake.inject({ match: (req) => {
      if (!changed && req.method === "DELETE" && req.path.endsWith(`/${kind === "Role" ? "roles" : "rolebindings"}/${object.metadata.name}`)) {
        changed = true;
        const live = fake.get(kind, NS, object.metadata.name)!;
        fake.remove(kind, NS, object.metadata.name);
        fake.seed({ ...live, metadata: { ...live.metadata, uid: undefined, resourceVersion: undefined, managedFields: undefined } }, "zenith");
      }
      return false;
    }, status: 200, message: "" });
    const r = await pruneOrphans({ desired: desired(id([])), namespaces: [NS], environmentId: ENV_ID }, await sessionFor(fake, []));
    expect(changed).toBe(true);
    expect(r.failed).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ kind }) }));
    expect(fake.get(kind, NS, object.metadata.name)).toBeDefined();
    const deletion = fake.requests.find((q) => q.method === "DELETE" && q.path.endsWith(`/${kind === "Role" ? "roles" : "rolebindings"}/${object.metadata.name}`));
    expect(dig(deletion?.body, "preconditions", "uid")).toMatch(/^uid-/);
  });

  it("checks the target namespace allowlist for cross-namespace roles", async () => {
    const target = { ...secretNode(), spec: { ...secretNode().spec, namespace: "data" } };
    const objects = renderGraph([networkNode(), serviceNode(), target, id()], { environmentId: ENV_ID }).objects;
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "data" } });
    const r = await serverSideApply(objects, await sessionFor(fake, [NS]), { environmentId: ENV_ID, resolveSecret: async () => "test-value" });
    expect(r.refused).toBe(true);
    expect(r.results).toContainEqual(expect.objectContaining({ errorCode: "namespace_forbidden", ref: expect.objectContaining({ kind: "Role", namespace: "data" }) }));
    expect(patches()).toHaveLength(0);
  });

  it("does not claim grant verification from the ServiceAccount alone", async () => {
    const n = id();
    expect((await apply(desired(n))).ok).toBe(true);
    const ctx = driverCtx(await sessionFor(fake, [NS]));
    const observed = await serviceAccountDriver.observe!(ctx, n);
    expect(observed.attributes.automountServiceAccountToken).toMatchObject({ state: "known", value: true });
    const result = await serviceAccountDriver.verify!(ctx, n, observed);
    expect(result.status).toBe("unknown");
    expect(result.checks.find((c) => c.id === "grants")?.passed).toBe("unknown");
  });
});
