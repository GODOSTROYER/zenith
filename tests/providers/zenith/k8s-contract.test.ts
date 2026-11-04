/**
 * Managed-hosting integration through the production Kubernetes renderer,
 * discovery client and server-side apply. The HTTP API is a contract fake:
 * these tests prove wiring and guards, not real-cluster admission or RBAC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOrphans, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, listObjects, readObject } from "@/lib/providers/kubernetes/client";
import { applyOrder, renderGraph } from "@/lib/providers/kubernetes/render";
import { ANNOTATION, APPLY_ORDER, KIND_INFO, LABEL, MANAGED_BY_VALUE, isSupportedKind } from "@/lib/providers/kubernetes/types";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { OWNERSHIP, ZENITH_EXTRA_KINDS, type KubernetesToolkit } from "@/lib/providers/zenith/k8s-port";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { FakeTlsClient } from "./tls-support";
import { startFakeK8s, type FakeK8s } from "../kubernetes/fake-api";
import { SECRET_CANARY, sessionFor } from "../kubernetes/helpers";
import { DNS, FW_LB_TO_WEB, FW_PUBLIC, FW_WEB_TO_WORKER, LB, NET, NS, SECRET, TENANT, TLS, WEB, WORKER, session, substrate } from "./support";

const toolkit: KubernetesToolkit = {
  renderGraph,
  apply: serverSideApply,
  read: (s, ref, signal) => readObject(createK8sClient(s, { signal }), ref),
  list: (s, q, signal) => {
    if (!isSupportedKind(q.kind)) throw new Error("Test toolkit only lists supported Kubernetes kinds.");
    return listObjects(createK8sClient(s, { signal }), q.kind, q.namespace, q);
  },
};
const nodes = [NET, WEB, WORKER, LB, SECRET, DNS, TLS, FW_PUBLIC, FW_LB_TO_WEB, FW_WEB_TO_WORKER];
const rendered = () => renderZenithEnvironment({ tenant: TENANT, substrate: substrate(), nodes, toolkit });

describe("the managed provider's Kubernetes vocabulary", () => {
  it("matches every ownership key and value to the Kubernetes constants", () => {
    expect(OWNERSHIP).toEqual({
      managedByLabel: LABEL.managedBy,
      managedByValue: MANAGED_BY_VALUE,
      partOfLabel: LABEL.partOf,
      nameLabel: LABEL.name,
      resourceAnnotation: ANNOTATION.resource,
      environmentAnnotation: ANNOTATION.environment,
      specDigestAnnotation: ANNOTATION.specDigest,
      secretRefAnnotation: ANNOTATION.secretRef,
    });
  });

  it("accepts every extra kind with the exact version, scope and apply order", () => {
    expect(new Set(APPLY_ORDER).size).toBe(APPLY_ORDER.length);
    expect([...APPLY_ORDER].sort()).toEqual(Object.keys(KIND_INFO).sort());
    for (const extra of ZENITH_EXTRA_KINDS) {
      expect(isSupportedKind(extra.kind), extra.kind).toBe(true);
      if (!isSupportedKind(extra.kind)) throw new Error("Missing Kubernetes kind.");
      expect(KIND_INFO[extra.kind]).toEqual({ apiVersion: extra.apiVersion, namespaced: true });
      expect(APPLY_ORDER).toContain(extra.kind);
    }
    const ordered = applyOrder([
      "HTTPRoute", "Deployment", "Service", "NetworkPolicy", "LimitRange", "ResourceQuota", "ServiceAccount", "Namespace",
    ].map((kind) => ({ kind, metadata: { name: "test" } })));
    expect(ordered.map((o) => o.kind)).toEqual([
      "Namespace", "ServiceAccount", "ResourceQuota", "LimitRange", "NetworkPolicy", "Service", "Deployment", "HTTPRoute",
    ]);
  });
});

describe("managed hosting through the Kubernetes HTTP contract API", () => {
  let fake: FakeK8s;
  let managed: ZenithSession;
  let tlsClient: FakeTlsClient;

  beforeEach(async () => {
    fake = await startFakeK8s();
    tlsClient = new FakeTlsClient();
    const kubernetes = await sessionFor(fake, [NS]);
    managed = session(unavailableDatabaseProvider("No database nodes in this contract test."), { kubernetes, expiresAt: kubernetes.expiresAt });
  });
  afterEach(async () => { await fake.close(); });

  const deploy = (over: Partial<Parameters<typeof applyZenithEnvironment>[0]> = {}) => applyZenithEnvironment({
    session: managed,
    expect: TENANT,
    nodes,
    toolkit,
    tlsClient,
    resolveSecret: async () => SECRET_CANARY,
    ...over,
  });

  it("renders and applies the baseline then workloads and Gateway API routes, and reapplying is a no-op", async () => {
    const r = rendered();
    expect(r.baseline.map((o) => o.kind)).toContain("ResourceQuota");
    expect(r.baseline.map((o) => o.kind)).toContain("LimitRange");
    expect(r.workloads.map((o) => o.kind)).toContain("HTTPRoute");
    expect(r.workloads.map((o) => o.kind)).not.toContain("Ingress");
    expect(JSON.stringify(r)).not.toContain(SECRET_CANARY);
    for (const o of [...r.baseline, ...r.workloads]) {
      if (o.kind !== "Namespace") expect(o.metadata.namespace).toBe(NS);
    }

    const logs: string[] = [];
    const first = await deploy({ log: (line) => logs.push(line) });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.baseline?.results.map((i) => i.status)).toEqual(r.baseline.map(() => "created"));
    expect(first.workloads?.results.map((i) => i.status)).toEqual(r.workloads.map(() => "created"));
    const writes = fake.writes();
    expect(writes.slice(0, r.baseline.length).map((w) => w.body.kind)).toEqual(applyOrder(r.baseline).map((o) => o.kind));
    for (const write of writes) {
      expect(write.method).toBe("PATCH");
      expect(write.query.fieldManager).toBe("zenith");
      expect(write.query.force).toBe("false");
      expect(write.contentType).toBe("application/apply-patch+yaml");
    }
    for (const extra of ZENITH_EXTRA_KINDS) {
      const object = [...r.baseline, ...r.workloads].find((o) => o.kind === extra.kind)!;
      expect(fake.get(extra.kind, NS, object.metadata.name)).toMatchObject(object);
      expect(await toolkit.read(managed.kubernetes, { apiVersion: extra.apiVersion, kind: extra.kind, namespace: NS, name: object.metadata.name })).toMatchObject(object);
      const listed = await toolkit.list(managed.kubernetes, { kind: extra.kind, namespace: NS });
      expect(listed.unavailable).toBe(false);
      expect(listed.items).toContainEqual(expect.objectContaining({ kind: extra.kind }));
    }
    const second = await deploy();
    expect(second.ok).toBe(true);
    expect([...second.baseline!.results, ...second.workloads!.results].every((i) => i.status === "unchanged")).toBe(true);
    const publicOutput = JSON.stringify({ first, second, logs, rendered: r });
    expect(publicOutput).not.toContain(SECRET_CANARY);
    expect(publicOutput).not.toContain(Buffer.from(SECRET_CANARY).toString("base64"));
    expect(publicOutput).not.toContain(fake.token);
  });

  it("dry-runs all phases without persisting any object", async () => {
    const r = await deploy({ dryRun: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(fake.writes().every((w) => w.query.dryRun === "All")).toBe(true);
    for (const o of [...rendered().baseline, ...rendered().workloads]) expect(fake.get(o.kind, o.metadata.namespace, o.metadata.name)).toBeUndefined();
  });

  it.each(["ResourceQuota", "LimitRange"])("refuses a foreign %s before any baseline or workload write", async (kind) => {
    const wanted = rendered().baseline.find((o) => o.kind === kind)!;
    fake.seed({ ...wanted, metadata: { name: wanted.metadata.name, namespace: NS, labels: { [LABEL.managedBy]: "helm" } } });
    const r = await deploy();
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toBe("baseline");
    expect(r.baseline?.refused).toBe(true);
    expect(r.baseline?.results).toContainEqual(expect.objectContaining({ status: "ownership_conflict", ref: expect.objectContaining({ kind }) }));
    expect(r.workloads).toBeUndefined();
    expect(fake.writes()).toHaveLength(0);
  });

  it("reports a missing Gateway API CRD and leaves all workloads unapplied", async () => {
    fake.setCrds(false);
    const r = await deploy();
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toBe("workloads");
    expect(r.baseline?.ok).toBe(true);
    expect(r.workloads?.refused).toBe(true);
    expect(r.workloads?.results).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ kind: "HTTPRoute" }), status: "error", errorCode: "unsupported" }));
    expect(fake.writes()).toHaveLength(rendered().baseline.length);
    expect(fake.list("Deployment", NS)).toEqual([]);
  });

  it("refuses a session opened for another tenant before making API calls", async () => {
    await expect(deploy({ expect: { ...TENANT, workspaceId: "another-workspace" } })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(fake.requests).toHaveLength(0);
  });

  it.each(ZENITH_EXTRA_KINDS)("rejects a wrong version or absent namespace for $kind without writes", async (extra) => {
    const wanted = [...rendered().baseline, ...rendered().workloads].find((o) => o.kind === extra.kind)!;
    for (const bad of [{ ...wanted, apiVersion: "wrong.example/v1" }, { ...wanted, metadata: { ...wanted.metadata, namespace: undefined } }]) {
      const r = await serverSideApply([bad], managed.kubernetes, { environmentId: TENANT.environmentId });
      expect(r.refused).toBe(true);
      expect(r.results[0]).toMatchObject({ status: "error", errorCode: "invalid_object" });
    }
    expect(fake.writes()).toHaveLength(0);
  });

  it.each(ZENITH_EXTRA_KINDS)("enforces the namespace allowlist for $kind", async (extra) => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "foreign" } });
    const wanted = [...rendered().baseline, ...rendered().workloads].find((o) => o.kind === extra.kind)!;
    const r = await serverSideApply([{ ...wanted, metadata: { ...wanted.metadata, namespace: "foreign" } }], managed.kubernetes, { environmentId: TENANT.environmentId });
    expect(r.refused).toBe(true);
    expect(r.results[0]).toMatchObject({ status: "error", errorCode: "namespace_forbidden" });
    expect(fake.writes()).toHaveLength(0);
  });

  it.each(ZENITH_EXTRA_KINDS)("reports field-manager conflicts on $kind without forcing", async (extra) => {
    const wanted = [...rendered().baseline, ...rendered().workloads].find((o) => o.kind === extra.kind)!;
    const spec = extra.kind === "ResourceQuota" ? { hard: { "requests.cpu": "999" } }
      : extra.kind === "LimitRange" ? { limits: [{ type: "Container", max: { cpu: "999" } }] }
      : { hostnames: ["old.apps.example.com"] };
    fake.seed({ ...wanted, spec }, "other-actor");
    const r = await serverSideApply([wanted], managed.kubernetes, { environmentId: TENANT.environmentId });
    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ status: "conflict", errorCode: "field_conflict", conflicts: expect.arrayContaining([expect.objectContaining({ manager: "other-actor" })]) });
    expect(fake.get(extra.kind, NS, wanted.metadata.name)?.spec).toEqual(spec);
    expect(fake.writes()[0].query.force).toBe("false");
  });

  it("refuses a route owned by another environment after applying only the baseline", async () => {
    const wanted = rendered().workloads.find((o) => o.kind === "HTTPRoute")!;
    fake.seed({ ...wanted, metadata: { ...wanted.metadata, annotations: { ...wanted.metadata.annotations, [ANNOTATION.environment]: "foreign-environment" } } });
    const r = await deploy();
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toBe("workloads");
    expect(r.workloads?.refused).toBe(true);
    expect(r.workloads?.results).toContainEqual(expect.objectContaining({ status: "ownership_conflict", ref: expect.objectContaining({ kind: "HTTPRoute" }) }));
    expect(fake.writes()).toHaveLength(rendered().baseline.length);
    expect(fake.list("Deployment", NS)).toEqual([]);
  });

  it("prunes extra kinds in reverse apply order while preserving another environment's objects", async () => {
    const objects = [...rendered().baseline, ...rendered().workloads].filter((o) => ZENITH_EXTRA_KINDS.some((extra) => extra.kind === o.kind));
    expect((await serverSideApply(objects, managed.kubernetes, { environmentId: TENANT.environmentId })).ok).toBe(true);
    for (const object of objects) {
      fake.seed({ ...object, metadata: { ...object.metadata, name: "other-environment", annotations: { ...object.metadata.annotations, [ANNOTATION.environment]: "foreign-environment" } } });
    }
    const pruned = await pruneOrphans({ desired: [], environmentId: TENANT.environmentId, namespaces: [NS] }, managed.kubernetes);
    expect(pruned.failed).toEqual([]);
    expect(pruned.deleted.map((ref) => ref.kind)).toEqual(["HTTPRoute", "LimitRange", "ResourceQuota"]);
    for (const object of objects) {
      expect(fake.get(object.kind, NS, object.metadata.name)).toBeUndefined();
      expect(fake.get(object.kind, NS, "other-environment")).toBeDefined();
    }
  });
});
