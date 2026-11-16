/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOrphans, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { ANNOTATION, LABEL, type K8sObject } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, cacheNode, dbNode, networkNode, secretNode, serviceNode, sessionFor, volumeNode } from "./helpers";

let fake: FakeK8s;
beforeEach(async () => {
  fake = await startFakeK8s();
});
afterEach(async () => {
  await fake.close();
});

const ctx = { environmentId: ENV_ID };
const render = (nodes: Parameters<typeof renderGraph>[0]) => renderGraph(nodes, ctx).objects;
const deletes = () => fake.requests.filter((r) => r.method === "DELETE");

async function deployAll(nodes: Parameters<typeof renderGraph>[0]): Promise<K8sObject[]> {
  const objects = render(nodes);
  const r = await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID, resolveSecret: async () => "generated-value-0001" });
  expect(r.ok).toBe(true);
  return objects;
}

const prune = async (desired: K8sObject[], over: Record<string, unknown> = {}) =>
  pruneOrphans({ desired, environmentId: ENV_ID, namespaces: [NS], ...over }, await sessionFor(fake, []));

describe("pruneOrphans", () => {
  it("deletes Zenith-owned objects of this environment that are no longer desired, children first", async () => {
    const all = await deployAll([networkNode(), serviceNode(), secretNode()]);
    const desired = all.filter((o) => o.kind === "Namespace" || o.kind === "NetworkPolicy");
    const r = await prune(desired);
    expect(r.deleted.map((d) => `${d.kind}/${d.name}`).sort()).toEqual(["Deployment/web", "Secret/" + all.find((o) => o.kind === "Secret")!.metadata.name, "Service/web"].sort());
    expect(r.failed).toEqual([]);
    expect(fake.get("Deployment", NS, "web")).toBeUndefined();
    expect(fake.get("Service", NS, "web")).toBeUndefined();
    expect(fake.get("NetworkPolicy", NS, "zenith-default-deny-ingress")).toBeDefined();
    // reverse apply order: Deployment before Service before Secret
    const order = deletes().map((d) => d.path.split("/").slice(-2)[0]);
    expect(order.indexOf("deployments")).toBeLessThan(order.indexOf("services"));
    expect(order.indexOf("services")).toBeLessThan(order.indexOf("secrets"));
  });

  it("deletes nothing when everything is still desired", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    const r = await prune(all);
    expect(r.deleted).toEqual([]);
    expect(deletes()).toHaveLength(0);
  });

  it("never touches objects without Zenith's marks, or marked for another environment", async () => {
    await deployAll([networkNode()]);
    fake.seed({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "legacy", namespace: NS, labels: { app: "legacy" } }, spec: { replicas: 1 } });
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "unlabeled", namespace: NS, annotations: { [ANNOTATION.environment]: ENV_ID } }, spec: {} });
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "other-env", namespace: NS, labels: { [LABEL.managedBy]: "zenith" }, annotations: { [ANNOTATION.environment]: OTHER_ENV } }, spec: {} });
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "other-tool", namespace: NS, labels: { [LABEL.managedBy]: "helm" }, annotations: { [ANNOTATION.environment]: ENV_ID } }, spec: {} });
    const r = await prune([]);
    expect(r.deleted.map((d) => d.name)).not.toContain("legacy");
    expect(deletes().map((d) => d.path)).toEqual(expect.not.arrayContaining([expect.stringContaining("legacy")]));
    for (const name of ["unlabeled", "other-env", "other-tool"]) expect(fake.get("Service", NS, name), name).toBeDefined();
    expect(fake.get("Deployment", NS, "legacy")).toBeDefined();
  });

  it("does not prune by label alone: the listing is narrowed by selector AND re-checked per object", async () => {
    await deployAll([networkNode()]);
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "no-annotation", namespace: NS, labels: { [LABEL.managedBy]: "zenith" } }, spec: {} });
    const r = await prune([]);
    expect(r.deleted.map((d) => d.name)).not.toContain("no-annotation");
    const lists = fake.requests.filter((q) => q.method === "GET" && q.query.labelSelector);
    expect(lists.length).toBeGreaterThan(5);
    expect(lists.every((q) => q.query.labelSelector === "app.kubernetes.io/managed-by=zenith")).toBe(true);
  });

  it("never deletes stateful kinds or namespaces: it reports them as retained", async () => {
    const all = await deployAll([networkNode(), dbNode(), cacheNode(), volumeNode()]);
    expect(all.length).toBeGreaterThan(8);
    const r = await prune([]); // nothing is desired any more
    const retained = r.retained.map((x) => `${x.ref.kind}/${x.ref.name}`).sort();
    expect(retained).toEqual(
      expect.arrayContaining(["StatefulSet/db", "StatefulSet/cache", "PersistentVolumeClaim/db-data", "PersistentVolumeClaim/cache-data", "PersistentVolumeClaim/uploads", `Namespace/${NS}`])
    );
    expect(r.retained.every((x) => /never pruned automatically/.test(x.reason))).toBe(true);
    expect(fake.list("StatefulSet")).toHaveLength(2);
    expect(fake.list("PersistentVolumeClaim")).toHaveLength(3);
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
    const deletedKinds = new Set(r.deleted.map((d) => d.kind));
    expect(deletedKinds.has("StatefulSet")).toBe(false);
    expect(deletedKinds.has("PersistentVolumeClaim")).toBe(false);
    expect(deletedKinds.has("Namespace")).toBe(false);
    // the non-stateful pieces of those nodes (their headless Services, credentials Secrets) ARE orphans and go
    expect(r.deleted.map((d) => `${d.kind}/${d.name}`)).toEqual(expect.arrayContaining(["Service/db", "Secret/db-credentials"]));
  });

  it("compares by kind, namespace and name: a desired Service does not protect a same-named Deployment", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    const r = await prune(all.filter((o) => o.kind !== "Deployment"));
    expect(r.deleted.map((d) => `${d.kind}/${d.name}`)).toEqual(["Deployment/web"]);
    expect(fake.get("Service", NS, "web")).toBeDefined();
  });

  it("a dry run reports what would be deleted and deletes nothing", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    const r = await prune(all.filter((o) => o.kind === "Namespace"), { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted.map((d) => d.kind).sort()).toEqual(["Deployment", "NetworkPolicy", "Service"]);
    expect(deletes()).toHaveLength(0);
    expect(fake.get("Deployment", NS, "web")).toBeDefined();
  });

  it("deletes with a uid precondition and leaves an object that was replaced in the meantime", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    let swapped = false;
    fake.inject({
      match: (req) => {
        if (req.method === "DELETE" && req.path.endsWith("/deployments/web") && !swapped) {
          swapped = true;
          const live = fake.get("Deployment", NS, "web") as any;
          fake.remove("Deployment", NS, "web");
          fake.seed({ ...live, metadata: { ...live.metadata, uid: undefined, managedFields: undefined, resourceVersion: undefined } }, "zenith");
        }
        return false;
      },
      status: 200,
      message: "",
    });
    const r = await prune(all.filter((o) => o.kind !== "Deployment" && o.kind !== "Service"));
    const del = deletes().find((d) => d.path.endsWith("/deployments/web"));
    expect(del?.body.preconditions.uid).toMatch(/^uid-/);
    expect(r.failed.find((f) => f.ref.kind === "Deployment")).toBeDefined();
    expect(fake.get("Deployment", NS, "web")).toBeDefined();
    expect(r.deleted.map((d) => d.kind)).toContain("Service");
  });

  it("skips objects that are already terminating, and treats an object that vanished as deleted", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    fake.foreignUpdate("Service", NS, "web", "gc", { metadata: { deletionTimestamp: "2026-01-01T00:00:00Z" } });
    const r = await prune(all.filter((o) => o.kind === "Namespace"));
    expect(r.deleted.map((d) => d.kind)).not.toContain("Service");
    expect(fake.get("Service", NS, "web")).toBeDefined();
  });

  it("scans only the namespaces it is given, and each must pass the allowlist", async () => {
    await deployAll([networkNode(), serviceNode()]);
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "other" } });
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "x", namespace: "other", labels: { [LABEL.managedBy]: "zenith" }, annotations: { [ANNOTATION.environment]: ENV_ID } }, spec: {} });
    const r = await pruneOrphans({ desired: [], environmentId: ENV_ID, namespaces: [NS, "other"] }, await sessionFor(fake, []));
    expect(r.failed).toEqual([expect.objectContaining({ code: "namespace_forbidden", ref: expect.objectContaining({ name: "other" }) })]);
    expect(fake.get("Service", "other", "x")).toBeDefined();
    const gone = await pruneOrphans({ desired: [], environmentId: ENV_ID, namespaces: ["never-existed"] }, await sessionFor(fake, []));
    expect(gone.failed).toEqual([]);
    expect(gone.deleted).toEqual([]);
  });

  it("names kinds the cluster does not serve instead of failing", async () => {
    await deployAll([networkNode()]);
    fake.setCrds(false);
    const r = await prune([]);
    expect(r.skippedKinds).toEqual(["Certificate", "DNSEndpoint", "HTTPRoute"]);
    expect(r.failed).toEqual([]);
  });

  it("reports listing failures per kind and keeps going", async () => {
    const all = await deployAll([networkNode(), serviceNode()]);
    fake.inject({ match: (q) => q.method === "GET" && q.path.endsWith("/namespaces/shop/services"), status: 500, message: "boom", times: 1 });
    const r = await prune(all.filter((o) => o.kind === "Namespace"));
    expect(r.failed.map((f) => f.ref.kind)).toEqual(["Service"]);
    expect(r.deleted.map((d) => d.kind)).toContain("Deployment");
  });

  it("stops scanning when aborted", async () => {
    await deployAll([networkNode(), serviceNode()]);
    const ac = new AbortController();
    ac.abort();
    await expect(pruneOrphans({ desired: [], environmentId: ENV_ID, namespaces: [NS] }, await sessionFor(fake, []), { signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("does not delete a Secret it could not have created: only owned, this-environment Secrets are candidates", async () => {
    await deployAll([networkNode(), secretNode()]);
    fake.seed({ apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: "someone-elses", namespace: NS }, data: { k: "dg==" } });
    const r = await prune([]);
    expect(r.deleted.map((d) => d.name)).not.toContain("someone-elses");
    expect(fake.get("Secret", NS, "someone-elses")).toBeDefined();
    expect(JSON.stringify(r)).not.toContain("dg==");
  });
});
