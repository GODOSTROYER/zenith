/** Existing HTTP Kubernetes and in-memory TLS contract fakes; no live cluster evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIND_INFO, type K8sObject, type SupportedKind } from "@/lib/providers/kubernetes/types";
import { unavailableDatabaseProvider, managedDatabaseName, type ManagedDatabaseProvider } from "@/lib/providers/zenith/database";
import { OWNERSHIP } from "@/lib/providers/zenith/k8s-port";
import { renderTenancy } from "@/lib/providers/zenith/tenancy";
import { teardownZenithEnvironment, type ZenithTeardownDatabase, type ZenithTeardownInput, type ZenithTeardownSession } from "@/lib/providers/zenith/teardown";
import { platformTlsMetadata, renderEnvironmentTls } from "@/lib/providers/zenith/tls";
import { TENANT_ANNOTATION } from "@/lib/providers/zenith/types";
import { startFakeK8s, type FakeK8s } from "../kubernetes/fake-api";
import { SECRET_CANARY, sessionFor } from "../kubernetes/helpers";
import { NS, TENANT, session, substrate } from "./support";
import { FakeTlsClient } from "./tls-support";

const namespaceRef = `Namespace//${NS}`;
const objectRef = (kind: string, name: string) => `${kind}/${NS}/${name}`;
const databaseRef = (address = "postgres/db") => objectRef("ManagedDatabase", managedDatabaseName({ ...TENANT, address }));

function object(kind: SupportedKind, name: string, over: Partial<K8sObject["metadata"]> = {}): K8sObject {
  return {
    apiVersion: KIND_INFO[kind].apiVersion, kind,
    metadata: {
      name, namespace: NS,
      labels: { [OWNERSHIP.managedByLabel]: OWNERSHIP.managedByValue },
      annotations: { [OWNERSHIP.environmentAnnotation]: TENANT.environmentId, [TENANT_ANNOTATION.workspaceId]: TENANT.workspaceId, [OWNERSHIP.resourceAnnotation]: `resource/${name}` },
      ...over,
    },
  };
}

describe("managed environment teardown", () => {
  let fake: FakeK8s;
  let tls: FakeTlsClient;
  let managed: ZenithTeardownSession;

  beforeEach(async () => {
    fake = await startFakeK8s();
    tls = new FakeTlsClient();
    const kubernetes = await sessionFor(fake, [NS]);
    managed = { ...session(unavailableDatabaseProvider("No databases in this fixture."), { kubernetes, expiresAt: kubernetes.expiresAt }), teardown: { databases: [], tlsClient: tls } };
    for (const baseline of renderTenancy(TENANT, substrate()).objects) fake.seed(baseline);
    for (const wanted of renderEnvironmentTls(TENANT, substrate())) tls.put(wanted);
    tls.put({ apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, substrate(), "Secret"), data: { value: SECRET_CANARY } });
  });
  afterEach(async () => { await fake.close(); });

  const teardown = (over: Partial<ZenithTeardownInput> = {}) => teardownZenithEnvironment({ ...TENANT, session: managed, retainStateful: false, ...over });
  function databases(entries: ZenithTeardownDatabase[], provider?: ManagedDatabaseProvider) {
    managed = { ...managed, ...(provider ? { databases: provider } : {}), teardown: { databases: entries, tlsClient: tls } };
  }
  function port() {
    return {
      ...unavailableDatabaseProvider("fake"),
      get: vi.fn<ManagedDatabaseProvider["get"]>().mockResolvedValue({ ok: true, value: null }),
      delete: vi.fn<ManagedDatabaseProvider["delete"]>().mockResolvedValue({ ok: true, value: { deleted: true, alreadyAbsent: false } }),
    };
  }

  it("prunes workloads, tears down TLS, and deletes only the tenant namespace last with preconditions", async () => {
    fake.seed(object("Service", "web"));
    fake.seed(object("CronJob", "worker"));
    const result = await teardown();
    expect(result.uncertain).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(result.deleted).toContain(namespaceRef);
    expect(result.deleted).toContain(objectRef("Service", "web"));
    expect(result.deleted).toContain(objectRef("CronJob", "worker"));
    expect(tls.writes.map((write) => write.object.kind)).toEqual(["Gateway", "Certificate", "Secret"]);
    expect(fake.writes().map((write) => write.path.split("/").at(-2))).toEqual(["cronjobs", "services", "namespaces"]);
    expect(fake.writes().at(-1)?.body.preconditions).toEqual({ uid: expect.any(String), resourceVersion: expect.any(String) });
    expect(fake.get("Namespace", undefined, NS)).toBeUndefined();
  });

  it("retains Secrets, PVCs, StatefulSets and the full isolation baseline while pruning workloads", async () => {
    for (const kind of ["Secret", "PersistentVolumeClaim", "StatefulSet", "Service"] as const) fake.seed(object(kind, "app"));
    const p = port();
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown({ retainStateful: true });
    expect(result.uncertain).toEqual([]);
    expect(result.deleted).toContain(objectRef("Service", "app"));
    for (const kind of ["Secret", "PersistentVolumeClaim", "StatefulSet"]) {
      expect(result.retained).toContain(objectRef(kind, "app"));
      expect(fake.get(kind, NS, "app")).toBeDefined();
    }
    expect(result.retained).toContain(databaseRef());
    for (const baseline of renderTenancy(TENANT, substrate()).objects) {
      expect(result.retained).toContain(`${baseline.kind}/${baseline.metadata.namespace ?? ""}/${baseline.metadata.name}`);
      expect(fake.get(baseline.kind, baseline.metadata.namespace, baseline.metadata.name)).toBeDefined();
    }
    expect(p.delete).not.toHaveBeenCalled();
    expect(tls.store.size).toBe(0);
  });

  it("explicitly deletes StatefulSets and PVCs before deleting their namespace", async () => {
    fake.seed(object("PersistentVolumeClaim", "data"));
    fake.seed(object("StatefulSet", "db"));
    const result = await teardown();
    expect(result.uncertain).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(result.deleted).toContain(objectRef("StatefulSet", "db"));
    expect(result.deleted).toContain(objectRef("PersistentVolumeClaim", "data"));
    expect(fake.writes().map((r) => r.path.split("/").at(-2))).toEqual(["statefulsets", "persistentvolumeclaims", "namespaces"]);
    expect(fake.writes().every((r) => r.body.preconditions.uid)).toBe(true);
  });

  it("dry-runs every phase without changing Kubernetes, TLS or databases", async () => {
    fake.seed(object("Service", "web"));
    fake.seed(object("PersistentVolumeClaim", "data"));
    const result = await teardown({ dryRun: true });
    expect(result.deleted).toContain(namespaceRef);
    expect(result.deleted).toContain(objectRef("Service", "web"));
    expect(result.deleted).toContain(objectRef("PersistentVolumeClaim", "data"));
    expect(result.uncertain).toEqual([]);
    expect(fake.writes()).toEqual([]);
    expect(fake.get("Service", NS, "web")).toBeDefined();
    expect(fake.get("PersistentVolumeClaim", NS, "data")).toBeDefined();
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
    expect(tls.store.size).toBe(3);
    expect(tls.writes.every((write) => write.dryRun)).toBe(true);
  });

  it("is idempotent when the namespace, workloads and TLS have gone", async () => {
    await teardown();
    fake.requests.length = 0;
    tls.writes.length = 0;
    const result = await teardown();
    expect(result.deleted).toEqual([]);
    expect(result.uncertain).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(result.skipped).toContain(namespaceRef);
    expect(fake.writes()).toEqual([]);
    expect(tls.writes).toEqual([]);
  });

  it.each(["workspaceId", "environmentId"] as const)("rejects a different %s before any I/O", async (field) => {
    await expect(teardown({ [field]: "other" })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(fake.requests).toEqual([]);
    expect(tls.writes).toEqual([]);
  });

  it.each([null, {}, { provider: "aws" }])("rejects invalid opaque sessions without exposing their contents", async (invalid) => {
    await expect(teardown({ session: invalid })).rejects.toMatchObject({ code: "session_invalid" });
    expect(fake.requests).toEqual([]);
  });

  it("rejects expired sessions before any I/O", async () => {
    await expect(teardown({ session: { ...managed, expiresAt: "2000-01-01T00:00:00Z" } })).rejects.toMatchObject({ code: "session_expired" });
    expect(fake.requests).toEqual([]);
    expect(tls.writes).toEqual([]);
  });

  it("fails closed on an invalid retention flag", async () => {
    await expect(teardown({ retainStateful: undefined as unknown as boolean })).rejects.toMatchObject({ code: "bad_input" });
    expect(fake.requests).toEqual([]);
  });

  it("preserves a conflicting namespace and makes no TLS or database writes", async () => {
    const ns = renderTenancy(TENANT, substrate()).objects[0];
    fake.seed({ ...ns, metadata: { ...ns.metadata, annotations: { ...ns.metadata.annotations, [TENANT_ANNOTATION.workspaceId]: "other" } } });
    const p = port();
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown();
    expect(result.skipped).toContain(namespaceRef);
    expect(result.uncertain).toContain(objectRef("ManagedDatabase", "*"));
    expect(fake.writes()).toEqual([]);
    expect(tls.writes).toEqual([]);
    expect(p.delete).not.toHaveBeenCalled();
  });

  it.each(["workspace", "environment", "unmanaged"])("leaves %s objects intact and prevents namespace cascade", async (foreign) => {
    const obj = object("Service", "foreign");
    if (foreign === "workspace") obj.metadata.annotations![TENANT_ANNOTATION.workspaceId] = "other";
    if (foreign === "environment") obj.metadata.annotations![OWNERSHIP.environmentAnnotation] = "other";
    if (foreign === "unmanaged") obj.metadata.labels = { [OWNERSHIP.managedByLabel]: "helm" };
    fake.seed(obj);
    fake.seed(object("Service", "mine"));
    const result = await teardown();
    expect(result.skipped).toContain(objectRef("Service", "foreign"));
    expect(result.retained).toContain(namespaceRef);
    expect(result.deleted).toContain(objectRef("Service", "mine"));
    expect(fake.get("Service", NS, "foreign")).toBeDefined();
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
  });

  it("does not scan or delete a different tenant namespace", async () => {
    fake.seed({ ...object("Service", "foreign"), metadata: { ...object("Service", "foreign").metadata, namespace: "another-tenant" } });
    await teardown();
    expect(fake.get("Service", "another-tenant", "foreign")).toBeDefined();
    expect(fake.requests.every((r) => !r.path.includes("another-tenant"))).toBe(true);
  });

  it("reports failed discovery and does not prune, delete databases or cascade", async () => {
    fake.seed(object("Service", "web"));
    fake.inject({ match: (r) => r.method === "GET" && r.path.endsWith("/services"), status: 403, message: SECRET_CANARY });
    const p = port();
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown();
    expect(result.uncertain).toContain(objectRef("Service", "*"));
    expect(result.uncertain).toContain(databaseRef());
    expect(result.retained).toContain(namespaceRef);
    expect(fake.writes()).toEqual([]);
    expect(p.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(result)).not.toContain(fake.token);
  });

  it("reports partial prune failure without deleting databases or the namespace", async () => {
    fake.seed(object("CronJob", "worker"));
    fake.seed(object("Service", "web"));
    fake.inject({ match: (r) => r.method === "DELETE" && r.path.endsWith("/services/web"), status: 500, message: SECRET_CANARY });
    const p = port();
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown();
    expect(result.deleted).toContain(objectRef("CronJob", "worker"));
    expect(result.uncertain).toContain(objectRef("Service", "web"));
    expect(result.uncertain).toContain(databaseRef());
    expect(result.retained).toContain(namespaceRef);
    expect(p.delete).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("keeps already terminating objects and their namespace uncertain", async () => {
    fake.seed(object("Service", "web", { deletionTimestamp: "2026-10-01T00:00:00Z" }));
    const result = await teardown();
    expect(result.uncertain).toContain(objectRef("Service", "web"));
    expect(result.retained).toContain(namespaceRef);
    expect(fake.writes()).toEqual([]);
  });

  it("does not claim completion for an already terminating namespace", async () => {
    const ns = renderTenancy(TENANT, substrate()).objects[0];
    fake.seed({ ...ns, metadata: { ...ns.metadata, deletionTimestamp: "2026-10-01T00:00:00Z" } });
    expect((await teardown()).uncertain).toContain(namespaceRef);
    expect(fake.writes()).toEqual([]);
    expect(tls.writes).toEqual([]);
  });

  it("reports cancellation before any write", async () => {
    const controller = new AbortController();
    controller.abort(new Error(SECRET_CANARY));
    const result = await teardown({ signal: controller.signal });
    expect(result.uncertain).toContain(namespaceRef);
    expect(result.deleted).toEqual([]);
    expect(fake.writes()).toEqual([]);
    expect(tls.writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("keeps the namespace when TLS ownership conflicts", async () => {
    const wanted = renderEnvironmentTls(TENANT, substrate())[0];
    tls.put({ ...wanted, metadata: { ...wanted.metadata, annotations: { ...wanted.metadata.annotations, [TENANT_ANNOTATION.workspaceId]: "other" } } });
    const result = await teardown();
    expect(result.skipped).toContain(`${wanted.kind}/${wanted.metadata.namespace}/${wanted.metadata.name}`);
    expect(result.retained).toContain(namespaceRef);
    expect(tls.writes).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("sanitizes TLS exceptions and preserves the namespace", async () => {
    tls.error = new Error(SECRET_CANARY);
    const result = await teardown();
    expect(result.uncertain.length).toBeGreaterThan(0);
    expect(result.retained).toContain(namespaceRef);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(fake.writes()).toEqual([]);
  });

  it("treats missing database inventory as unknown and preserves the baseline", async () => {
    managed = { ...managed, teardown: { tlsClient: tls } };
    const result = await teardown();
    expect(result.uncertain).toContain(objectRef("ManagedDatabase", "*"));
    expect(result.retained).toContain(namespaceRef);
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
  });

  it.each([
    { deletionPolicy: "deny" as const, approved: true },
    { deletionPolicy: "approval" as const },
  ])("retains a database under policy $deletionPolicy", async (policy) => {
    const p = port();
    databases([{ address: "postgres/db", ...policy }], p);
    const result = await teardown();
    expect(result.retained).toContain(databaseRef());
    expect(result.deleted).toContain(namespaceRef);
    expect(p.get).not.toHaveBeenCalled();
    expect(p.delete).not.toHaveBeenCalled();
  });

  it.each(["allow", "approval"] as const)("deletes through the existing lifecycle gate under policy %s", async (deletionPolicy) => {
    const p = port();
    databases([{ address: "postgres/db", deletionPolicy, approved: true, externalId: "proj-1" }], p);
    const signal = new AbortController().signal;
    const result = await teardown({ signal });
    expect(result.deleted).toContain(databaseRef());
    expect(p.delete).toHaveBeenCalledExactlyOnceWith({ workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, address: "postgres/db", externalId: "proj-1" }, { signal });
  });

  it("marks an idempotently absent database skipped", async () => {
    const p = port();
    p.delete.mockResolvedValue({ ok: true, value: { deleted: false, alreadyAbsent: true } });
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    expect((await teardown()).skipped).toContain(databaseRef());
  });

  it("does not treat an unconfirmed database response as successful", async () => {
    const p = port();
    p.delete.mockResolvedValue({ ok: true, value: { deleted: false, alreadyAbsent: false } });
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown();
    expect(result.uncertain).toContain(databaseRef());
    expect(result.retained).toContain(namespaceRef);
  });

  it("never exposes a throwing database adapter's secret error", async () => {
    const p = port();
    p.delete.mockRejectedValue(new Error(SECRET_CANARY));
    databases([{ address: "postgres/db", deletionPolicy: "allow" }], p);
    const result = await teardown();
    expect(result.uncertain).toContain(databaseRef());
    expect(result.retained).toContain(namespaceRef);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("rejects duplicate inventory before any I/O", async () => {
    databases([{ address: "postgres/db", deletionPolicy: "allow" }, { address: "postgres/db", deletionPolicy: "deny" }]);
    await expect(teardown()).rejects.toMatchObject({ code: "bad_input" });
    expect(fake.requests).toEqual([]);
    expect(tls.writes).toEqual([]);
  });

  it("rejects unknown policies rather than allowing deletion", async () => {
    databases([{ address: "postgres/db", deletionPolicy: "unknown" as "allow" }]);
    await expect(teardown()).rejects.toMatchObject({ code: "bad_input" });
    expect(fake.requests).toEqual([]);
  });

  it("returns sorted, unique, disjoint reference arrays", async () => {
    fake.seed(object("Service", "z"));
    fake.seed(object("Service", "a"));
    const result = await teardown({ retainStateful: true });
    for (const refs of Object.values(result)) expect(refs).toEqual([...new Set(refs)].sort());
    const all = Object.values(result).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("reports unsupported CRDs as skipped without fabricating deletions", async () => {
    fake.setCrds(false);
    const result = await teardown();
    expect(result.skipped).toContain(objectRef("HTTPRoute", "*"));
    expect(result.skipped).toContain(objectRef("Certificate", "*"));
    expect(result.uncertain).toEqual([]);
  });

  it("reports a namespace delete failure and preserves baseline references", async () => {
    fake.inject({ match: (r) => r.method === "DELETE" && r.path.endsWith(`/namespaces/${NS}`), status: 403, message: SECRET_CANARY });
    const result = await teardown();
    expect(result.uncertain).toContain(namespaceRef);
    expect(result.deleted).not.toContain(namespaceRef);
    expect(result.retained).toContain(objectRef("NetworkPolicy", "zenith-default-deny"));
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("does not delete a StatefulSet replaced after discovery", async () => {
    fake.seed(object("StatefulSet", "db"));
    let reads = 0;
    fake.inject({
      match: (r) => {
        if (r.method === "GET" && r.path.endsWith("/statefulsets/db") && ++reads === 1) {
          fake.remove("StatefulSet", NS, "db");
          fake.seed(object("StatefulSet", "db"));
        }
        return false;
      }, status: 500, message: "unused",
    });
    const result = await teardown();
    expect(result.uncertain).toContain(objectRef("StatefulSet", "db"));
    expect(result.retained).toContain(namespaceRef);
    expect(fake.get("StatefulSet", NS, "db")).toBeDefined();
    expect(fake.writes()).toEqual([]);
  });

  it("keeps stateful objects discovered by prune after the initial inventory", async () => {
    let listings = 0;
    fake.inject({ match: (r) => {
      if (r.method === "GET" && r.path.endsWith("/persistentvolumeclaims") && ++listings === 2) fake.seed(object("PersistentVolumeClaim", "new-data"));
      return false;
    }, status: 500, message: "unused" });
    const result = await teardown();
    expect(result.retained).toContain(objectRef("PersistentVolumeClaim", "new-data"));
    expect(result.retained).toContain(namespaceRef);
    expect(fake.get("PersistentVolumeClaim", NS, "new-data")).toBeDefined();
    expect(fake.writes()).toEqual([]);
  });

  it("refuses to prune or cascade after bounded inventory truncation", async () => {
    for (let i = 0; i < 1001; i++) fake.seed(object("Service", `service-${i}`));
    const result = await teardown();
    expect(result.uncertain).toContain(objectRef("Service", "*"));
    expect(result.retained).toContain(namespaceRef);
    expect(fake.writes()).toEqual([]);
  });

  it("does not delete a namespace replaced after the initial ownership read", async () => {
    let reads = 0;
    fake.inject({ match: (r) => {
      if (r.method === "GET" && r.path.endsWith(`/namespaces/${NS}`) && ++reads === 2) {
        fake.remove("Namespace", undefined, NS);
        fake.seed(renderTenancy(TENANT, substrate()).objects[0]);
      }
      return false;
    }, status: 500, message: "unused" });
    const result = await teardown();
    expect(result.uncertain).toContain(namespaceRef);
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
    expect(fake.writes()).toEqual([]);
  });
});
