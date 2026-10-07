/**
 * PROD-MAN-02/03 through the PRODUCTION Kubernetes renderer, discovery client and server-side apply, against the Kubernetes
 * HTTP contract fake (tests/providers/kubernetes/fake-api.ts): autoscaling, a verified custom domain's route and TLS objects,
 * tenant object-store provisioning and secret delivery, in one apply. Contract evidence only: this proves the wiring and the
 * guards, not real-cluster admission, a gateway controller, cert-manager issuance or an IAM provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, listObjects, readObject } from "@/lib/providers/kubernetes/client";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { isSupportedKind } from "@/lib/providers/kubernetes/types";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import type { KubernetesToolkit } from "@/lib/providers/zenith/k8s-port";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { customDomainTlsNames, environmentTlsNames } from "@/lib/providers/zenith/tls";
import type { ResourceNode } from "@/lib/resources/types";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { SECRET_CANARY, sessionFor } from "../providers/kubernetes/helpers";
import { FakeTlsClient } from "../providers/zenith/tls-support";
import { DNS, FULL_ENV, FW_LB_TO_WEB, FW_PUBLIC, FW_WEB_TO_WORKER, NET, NS, SECRET, TENANT, TLS, WEB, WORKER, mkNode, session } from "../providers/zenith/support";
import { FakeAdmin, MemoryKeyStore, MemorySink } from "./_support/storage";

const toolkit: KubernetesToolkit = {
  renderGraph,
  apply: serverSideApply,
  read: (s, ref, signal) => readObject(createK8sClient(s, { signal }), ref),
  list: (s, q, signal) => {
    if (!isSupportedKind(q.kind)) throw new Error("Test toolkit only lists supported Kubernetes kinds.");
    return listObjects(createK8sClient(s, { signal }), q.kind, q.namespace, q);
  },
};

const HOST = "shop.customer.com";
const ENV = { ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: "zenith-letsencrypt-http01", ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" };
const LB_CUSTOM = mkNode("load_balancer/public", "load_balancer", {
  scheme: "internet-facing", tier: "public", listeners: [{ port: 443, protocol: "https" }],
  routes: [{ host: HOST, pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }],
});
const OS = mkNode("object_store/media", "object_store", { versioning: true, publicAccess: false });
const nodes = (extra: ResourceNode[] = []): ResourceNode[] => [NET, WEB, WORKER, LB_CUSTOM, SECRET, DNS, TLS, FW_PUBLIC, FW_LB_TO_WEB, FW_WEB_TO_WORKER, ...extra];
const custom = customDomainTlsNames(TENANT, HOST);

describe("managed serving through the Kubernetes HTTP contract API", () => {
  let fake: FakeK8s;
  let managed: ZenithSession;
  let tlsClient: FakeTlsClient;
  let admin: FakeAdmin;
  let sink: MemorySink;
  let store: MemoryKeyStore;

  beforeEach(async () => {
    fake = await startFakeK8s();
    tlsClient = new FakeTlsClient();
    admin = new FakeAdmin();
    sink = new MemorySink();
    store = new MemoryKeyStore(TENANT.workspaceId, TENANT.environmentId);
    const kubernetes = await sessionFor(fake, [NS]);
    managed = session(unavailableDatabaseProvider("No database nodes in this contract test."), { kubernetes, expiresAt: kubernetes.expiresAt, customDomains: [HOST], storage: { admin, sink, store } }, ENV);
  });
  afterEach(async () => { await fake.close(); });

  const deploy = (over: Partial<Parameters<typeof applyZenithEnvironment>[0]> = {}) => applyZenithEnvironment({
    session: managed, expect: TENANT, nodes: nodes([OS]), toolkit, tlsClient, resolveSecret: async () => SECRET_CANARY, autoscaling: true, ...over,
  });

  it("applies autoscaling, the custom domain's route and TLS, a scoped object store and a vault-delivered secret, then reapplying is a no-op", async () => {
    const first = await deploy();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.blockedBy).toBeUndefined();

    // autoscaling: the production renderer's HPA, clamped by the tier, owning the replica count
    const hpa = fake.get("HorizontalPodAutoscaler", NS, "web");
    expect(hpa?.spec).toMatchObject({ scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2, maxReplicas: 4, behavior: { scaleDown: { stabilizationWindowSeconds: 300 } } });
    expect(fake.get("Deployment", NS, "web")?.spec).not.toHaveProperty("replicas");
    expect(fake.get("HorizontalPodAutoscaler", NS, "worker")).toBeUndefined();

    // the verified custom domain: a route for exactly that host on exactly that host's listener
    const route = fake.list("HTTPRoute", NS)[0];
    expect(route.spec).toMatchObject({ hostnames: [HOST], parentRefs: [expect.objectContaining({ sectionName: custom.listener })] });
    expect(first.hostnames).toEqual([{ source: HOST, managed: HOST, target: "container_service/web" }]);
    const gateway = tlsClient.store.get(`Gateway/zenith-gateway/${environmentTlsNames(TENANT, managed.substrate).gateway}`)!;
    expect((gateway.spec!.listeners as { name: string }[]).map((l) => l.name)).toEqual([environmentTlsNames(TENANT, managed.substrate).listener, custom.listener]);
    expect(tlsClient.store.has(`Certificate/zenith-gateway/${custom.certificate}`)).toBe(true);
    expect(first.tls).toMatchObject({ ok: true, readiness: "unknown" });

    // the object store: one scoped principal and key, only references in the report and the cluster
    expect(first.storage).toMatchObject([{ status: "created", address: "object_store/media" }]);
    expect(admin.principals.size).toBe(1);
    const secrets = [...admin.allSecrets(), SECRET_CANARY];
    const nonSecretBodies = fake.writes().filter((w) => w.body.kind !== "Secret").map((w) => w.body);
    const publicOutput = JSON.stringify({ first, nonSecretBodies, tls: tlsClient.writes });
    for (const s of secrets) expect(publicOutput, "a secret reached a manifest or a report").not.toContain(s);
    for (const s of secrets) expect(publicOutput).not.toContain(Buffer.from(s).toString("base64"));
    // an object-store key never goes to the cluster at all: it is delivered through the vault reference only
    for (const s of admin.allSecrets()) expect(JSON.stringify(fake.writes())).not.toContain(s);

    // the vault-delivered Secret object is the one place the resolved value lands; the rendered manifest only names the reference
    expect(fake.list("Secret", NS).length).toBeGreaterThanOrEqual(1);
    expect(fake.writes().filter((w) => w.body.kind === "Secret").length).toBeGreaterThanOrEqual(1);

    const second = await deploy();
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect([...second.baseline!.results, ...second.workloads!.results].every((i) => i.status === "unchanged")).toBe(true);
    expect(second.storage[0].status).toBe("exists");
    expect(admin.principals.size).toBe(1);
    expect([...admin.principals.values()][0].keys.size).toBe(1);
    expect(second.tls!.results.every((r) => r.status === "configured")).toBe(true);
  });

  it("clamps an autoscaler to the tier's ceiling and keeps the Deployment's replicas with it", async () => {
    const big = mkNode(WEB.address, "container_service", { ...(WEB.spec as Record<string, unknown>), replicas: 4 });
    const r = await deploy({ nodes: [NET, big, WORKER, LB_CUSTOM, SECRET, DNS, TLS, FW_PUBLIC, FW_LB_TO_WEB, FW_WEB_TO_WORKER] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.notes.join("\n")).toMatch(/autoscaling 4-5 replicas on CPU \(requested 8, limited by the starter plan quota\)/);
    expect(fake.get("HorizontalPodAutoscaler", NS, "web")?.spec).toMatchObject({ minReplicas: 4, maxReplicas: 5 });
  });

  it("does not autoscale unless asked", async () => {
    const r = await deploy({ autoscaling: undefined });
    expect(r.ok).toBe(true);
    expect(fake.list("HorizontalPodAutoscaler", NS)).toEqual([]);
    expect(fake.get("Deployment", NS, "web")?.spec).toHaveProperty("replicas", 2);
  });

  it("serves nothing for a domain that is not in the verified set, and removes a retired one's TLS objects", async () => {
    const unverified = await deploy({ session: { ...managed, customDomains: [] } as ZenithSession, nodes: nodes() });
    expect(unverified.ok, JSON.stringify(unverified)).toBe(true);
    expect(fake.list("HTTPRoute", NS)[0].spec).toMatchObject({ hostnames: ["web.production.acme.apps.example.com"] });
    expect(tlsClient.store.has(`Certificate/zenith-gateway/${custom.certificate}`)).toBe(false);

    await deploy({ nodes: nodes() });
    expect(tlsClient.store.has(`Certificate/zenith-gateway/${custom.certificate}`)).toBe(true);
    const retired = await deploy({ session: { ...managed, customDomains: [] } as ZenithSession, retiredDomains: [HOST], nodes: nodes() });
    expect(retired.ok, JSON.stringify(retired)).toBe(true);
    expect(tlsClient.store.has(`Certificate/zenith-gateway/${custom.certificate}`)).toBe(false);
  });

  it("stops before the baseline when an object store cannot be provisioned", async () => {
    admin.available = { available: false, reason: "admin credential not readable" };
    const r = await deploy();
    expect(r).toMatchObject({ ok: false, blockedBy: "storage" });
    expect(fake.writes()).toHaveLength(0);
  });

  it("dry-runs every phase, including storage, without persisting or calling the provider", async () => {
    const r = await deploy({ dryRun: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.storage[0].status).toBe("planned");
    expect(admin.calls).toEqual([]);
    expect(fake.writes().every((w) => w.query.dryRun === "All")).toBe(true);
    expect(fake.get("HorizontalPodAutoscaler", NS, "web")).toBeUndefined();
  });
});
