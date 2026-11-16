/**
 * PROD-MAN-02/03 inside the managed provider's real pipeline: custom domains (render, isolation gate, TLS lifecycle), tenant
 * object stores (render, apply, driver), autoscaling policy and the plaintext-secret gate. The Kubernetes toolkit and the TLS
 * client are the suite's recording doubles (contract evidence); the DNS proof itself is covered in domains.test.ts.
 */
import { describe, expect, it } from "vitest";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import { constrainAutoscalers, cpuMillis } from "@/lib/providers/zenith/autoscale";
import { unavailableDatabaseProvider } from "@/lib/providers/zenith/database";
import { createZenithDrivers } from "@/lib/providers/zenith/drivers";
import { createHttpRouteDriver } from "@/lib/providers/zenith/drivers/network/http-route";
import { validateTenantObjects } from "@/lib/providers/zenith/isolation";
import type { K8sObject, ToolkitRenderBase } from "@/lib/providers/zenith/k8s-port";
import { assessZenithGraph, renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { HTTPROUTE_API_VERSION } from "@/lib/providers/zenith/routing";
import { ensureZenithTls, teardownZenithTls } from "@/lib/providers/zenith/tls-lifecycle";
import { customDomainTlsNames, environmentGatewayParent, environmentTlsNames, isRouteParentFor, listenerForHost, platformTlsMetadata, renderEnvironmentTls } from "@/lib/providers/zenith/tls";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";
import type { ResourceNode } from "@/lib/resources/types";
import { storageIntentFromNode } from "@/lib/managed-serving/storage";
import { FakeTlsClient } from "../providers/zenith/tls-support";
import { FULL_ENV, FakeToolkit, TENANT, WEB, driverCtx, mkNode, session, substrate } from "../providers/zenith/support";
import { FakeAdmin, MemoryKeyStore, MemorySink } from "./_support/storage";

const HTTP_ISSUER = "zenith-letsencrypt-http01";
const ADMIN_REF = "vault:zenith-managed/object-store-admin";
const SUB = substrate({ ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: HTTP_ISSUER, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF });
const NS = tenantNamespace(TENANT.workspaceId, TENANT.environmentId);
const HOST = "shop.customer.com";
const lbFor = (...hosts: string[]): ResourceNode => mkNode("load_balancer/public", "load_balancer", {
  scheme: "internet-facing", tier: "public", listeners: [{ port: 443, protocol: "https" }],
  routes: hosts.map((host) => ({ host, pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 })),
});
const render = (nodes: ResourceNode[], over: Partial<Parameters<typeof renderZenithEnvironment>[0]> = {}) =>
  renderZenithEnvironment({ tenant: TENANT, substrate: SUB, nodes, toolkit: new FakeToolkit(), ...over });
const routes = (objects: K8sObject[]) => objects.filter((o) => o.kind === "HTTPRoute");
const custom = (host: string) => customDomainTlsNames(TENANT, host);

describe("custom domains in the managed render", () => {
  it("serves a verified host under its own HTTPS listener and certificate, and routes only that host there", () => {
    const r = render([WEB, lbFor(HOST)], { verifiedDomains: [HOST] });
    expect(r.customDomains).toEqual([HOST]);
    expect(r.hostnames).toEqual([{ source: HOST, managed: HOST, target: "container_service/web" }]);
    const [route] = routes(r.workloads);
    expect(route.spec).toMatchObject({ hostnames: [HOST], parentRefs: [environmentGatewayParent(TENANT, SUB, custom(HOST).listener)] });
    expect(r.notes.join("\n")).not.toMatch(/not served on the managed platform/);

    const [wildcardCert, hostCert, gateway] = r.platformTls;
    expect(r.platformTls.map((o) => o.kind)).toEqual(["Certificate", "Certificate", "Gateway"]);
    expect(wildcardCert.spec!.dnsNames).toEqual(["*.production.acme.apps.example.com"]);
    expect(hostCert.spec).toMatchObject({ dnsNames: [HOST], secretName: custom(HOST).secret, issuerRef: { kind: "ClusterIssuer", name: HTTP_ISSUER } });
    expect(hostCert.metadata.name).toBe(custom(HOST).certificate);
    const listeners = gateway.spec!.listeners as { name: string; hostname: string; tls: { certificateRefs: { name: string }[] }; allowedRoutes: unknown }[];
    expect(listeners.map((l) => l.name)).toEqual([environmentTlsNames(TENANT, SUB).listener, custom(HOST).listener]);
    expect(listeners[1]).toMatchObject({ hostname: HOST, tls: { certificateRefs: [{ name: custom(HOST).secret }] } });
    // the custom listener admits routes from exactly the tenant namespace, like the wildcard one
    expect(listeners[1].allowedRoutes).toEqual(listeners[0].allowedRoutes);
    // the generated key secrets are owned and labelled so teardown can never adopt a foreign one
    expect(platformTlsMetadata(TENANT, SUB, "Secret", HOST).annotations["zenith.dev/resource"]).toBe(`platform/tls-secret-${custom(HOST).listener}`);
    expect(JSON.stringify(r.platformTls)).not.toMatch(/PRIVATE KEY|tls\.key/);
  });

  it("keeps a managed host on the wildcard listener even when a custom host sits beside it", () => {
    const managedHost = "web.production.acme.apps.example.com";
    const r = render([WEB, lbFor(managedHost, HOST)], { verifiedDomains: [HOST] });
    const byHost = new Map(routes(r.workloads).map((o) => [(o.spec!.hostnames as string[])[0], (o.spec!.parentRefs as { sectionName: string }[])[0].sectionName]));
    expect(byHost.get(managedHost)).toBe(environmentTlsNames(TENANT, SUB).listener);
    expect(byHost.get(HOST)).toBe(custom(HOST).listener);
  });

  it("rewrites a host that is not verified to its managed hostname, as before, and says why", () => {
    const r = render([WEB, lbFor(HOST)]);
    expect(r.customDomains).toEqual([]);
    expect(r.platformTls.map((o) => o.kind)).toEqual(["Certificate", "Gateway"]);
    expect(r.notes.join("\n")).toMatch(/shop\.customer\.com is not served on the managed platform.*verified custom domain.*web\.production\.acme\.apps\.example\.com/);
    expect((routes(r.workloads)[0].spec!.hostnames as string[])[0]).toBe("web.production.acme.apps.example.com");
    // a verified domain with no route renders nothing and costs nothing
    expect(render([WEB], { verifiedDomains: [HOST] }).customDomains).toEqual([]);
  });

  it("does not serve a verified host the substrate cannot issue for (no HTTP-01 issuer, or ingress mode), and says so", () => {
    const noIssuer = substrate({ ...FULL_ENV });
    const a = render([WEB, lbFor(HOST)], { substrate: noIssuer, verifiedDomains: [HOST] });
    expect(a.customDomains).toEqual([]);
    expect(a.notes.join("\n")).toMatch(/verified but this platform cannot serve it/);
    expect((routes(a.workloads)[0].spec!.hostnames as string[])[0]).toBe("web.production.acme.apps.example.com");
    expect(() => renderEnvironmentTls(TENANT, noIssuer, { customDomains: [HOST] })).toThrow(/HTTP-01/);

    const ingress = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx", ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: HTTP_ISSUER });
    expect(render([WEB, lbFor(HOST)], { substrate: ingress, verifiedDomains: [HOST] }).customDomains).toEqual([]);
  });

  it("renders byte-identically whatever order the verified domains arrive in", () => {
    const two = lbFor(HOST, "api.customer.com");
    const a = render([WEB, two], { verifiedDomains: [HOST, "api.customer.com"] });
    const b = render([WEB, two], { verifiedDomains: ["api.customer.com", HOST, HOST] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  describe("the isolation gate", () => {
    const route = (hostnames: string[], section: string): K8sObject => ({
      apiVersion: HTTPROUTE_API_VERSION, kind: "HTTPRoute",
      metadata: { name: "r", namespace: NS, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations: { "zenith.dev/resource": "load_balancer/public", "zenith.dev/environment": TENANT.environmentId } },
      spec: { parentRefs: [environmentGatewayParent(TENANT, SUB, section)], hostnames, rules: [{ backendRefs: [{ name: "web", port: 8080 }] }] },
    });
    const violations = (o: K8sObject, hosts: string[] = []) => validateTenantObjects([o], { tenant: TENANT, substrate: SUB, customHosts: new Set(hosts) }).map((v) => v.rule);
    const wildcard = environmentTlsNames(TENANT, SUB).listener;

    it("accepts a verified custom host on its own listener", () => {
      expect(violations(route([HOST], custom(HOST).listener), [HOST])).toEqual([]);
    });
    it("refuses a custom host that is not verified for this environment", () => {
      expect(violations(route([HOST], custom(HOST).listener))).toContain("route_hostname");
      expect(violations(route([HOST], custom(HOST).listener), ["other.customer.com"])).toContain("route_hostname");
    });
    it("refuses a route on the wrong listener: custom host on the wildcard, managed host on a custom listener, another host's listener", () => {
      expect(violations(route([HOST], wildcard), [HOST])).toContain("route_parent");
      expect(violations(route(["web.production.acme.apps.example.com"], custom(HOST).listener), [HOST])).toContain("route_parent");
      expect(violations(route([HOST], custom("other.customer.com").listener), [HOST])).toContain("route_parent");
    });
    it("refuses a route that mixes managed and custom hostnames", () => {
      expect(violations(route([HOST, "web.production.acme.apps.example.com"], custom(HOST).listener), [HOST])).toContain("route_parent");
    });
    it("derives the listener from the host", () => {
      expect(listenerForHost(HOST, TENANT, SUB)).toBe(custom(HOST).listener);
      expect(listenerForHost("web.production.acme.apps.example.com", TENANT, SUB)).toBe(wildcard);
      expect(isRouteParentFor(environmentGatewayParent(TENANT, SUB, custom(HOST).listener), [HOST], TENANT, SUB)).toBe(true);
      expect(isRouteParentFor(environmentGatewayParent(TENANT, SUB, custom(HOST).listener), [], TENANT, SUB)).toBe(false);
      expect(isRouteParentFor(environmentGatewayParent(TENANT, SUB, custom(HOST).listener), [42], TENANT, SUB)).toBe(false);
    });
    it("gives distinct names to distinct hosts and to distinct environments", () => {
      const other = { ...TENANT, environmentId: "env_other" };
      expect(new Set([custom(HOST).listener, custom("api.customer.com").listener]).size).toBe(2);
      expect(customDomainTlsNames(other, HOST).certificate).not.toBe(custom(HOST).certificate);
      for (const n of Object.values(custom("a".repeat(60) + ".customer.com"))) expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    });
  });

  describe("the TLS lifecycle", () => {
    const input = (client: FakeTlsClient, over: Record<string, unknown> = {}) => ({ session: session(unavailableDatabaseProvider("none"), {}, { ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: HTTP_ISSUER }), expect: TENANT, tlsClient: client, ...over });
    const kinds = (client: FakeTlsClient) => [...client.store.keys()].sort();

    it("creates the host's certificate before the gateway listener that needs it, then converges", async () => {
      const client = new FakeTlsClient();
      const first = await ensureZenithTls(input(client, { customDomains: [HOST] }));
      expect(first).toMatchObject({ ok: true, readiness: "unknown" });
      expect(client.writes.map((w) => (w.object as K8sObject).kind)).toEqual(["Certificate", "Certificate", "Gateway"]);
      expect((await ensureZenithTls(input(client, { customDomains: [HOST] }))).results.map((r) => r.status)).toEqual(["configured", "configured", "configured"]);
    });

    it("removes a retired host's certificate and key, and only when this platform owns them", async () => {
      const client = new FakeTlsClient();
      await ensureZenithTls(input(client, { customDomains: [HOST] }));
      client.put({ apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, SUB, "Secret", HOST), data: { "tls.key": "PRIVATE-KEY-CANARY" } });
      expect(kinds(client).filter((k) => k.includes(custom(HOST).certificate) || k.includes(custom(HOST).secret))).toHaveLength(2);
      const after = await ensureZenithTls(input(client, { customDomains: [], retiredDomains: [HOST] }));
      expect(after.ok).toBe(true);
      expect(after.results.filter((r) => r.status === "deleted")).toHaveLength(2);
      expect(kinds(client).some((k) => k.includes(custom(HOST).certificate))).toBe(false);
      expect(kinds(client).some((k) => k.includes(custom(HOST).secret))).toBe(false);
      // the wildcard and the gateway (now without that listener) are untouched
      expect(client.store.has(`Gateway/zenith-gateway/${environmentTlsNames(TENANT, SUB).gateway}`)).toBe(true);
      const gateway = client.store.get(`Gateway/zenith-gateway/${environmentTlsNames(TENANT, SUB).gateway}`)!;
      expect((gateway.spec!.listeners as unknown[]).length).toBe(1);
    });

    it("refuses before any write when a custom key Secret is not ours", async () => {
      const client = new FakeTlsClient();
      client.put({ apiVersion: "v1", kind: "Secret", metadata: { ...platformTlsMetadata(TENANT, SUB, "Secret", HOST), labels: {}, annotations: {} } });
      const r = await ensureZenithTls(input(client, { customDomains: [HOST] }));
      expect(r.ok).toBe(false);
      expect(r.results.some((x) => x.status === "ownership_conflict")).toBe(true);
      expect(client.writes).toEqual([]);
    });

    it("tears down the host's objects together with the environment's", async () => {
      const client = new FakeTlsClient();
      await ensureZenithTls(input(client, { customDomains: [HOST] }));
      client.put({ apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(TENANT, SUB, "Secret", HOST) });
      const gone = await teardownZenithTls(input(client, { customDomains: [HOST] }));
      expect(gone.ok).toBe(true);
      expect(client.store.size).toBe(0);
    });
  });

  it("the route driver finds a custom host's route by its own name and listener", async () => {
    const toolkit = new FakeToolkit();
    const r = render([WEB, lbFor(HOST)], { verifiedDomains: [HOST] });
    for (const o of routes(r.workloads)) toolkit.put(o);
    const s = session(unavailableDatabaseProvider("none"), { customDomains: [HOST] }, { ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: HTTP_ISSUER });
    const driver = createHttpRouteDriver(toolkit);
    const observed = await driver.observe!(driverCtx(s), lbFor(HOST), undefined);
    expect(observed.presence).toBe("present");
    expect(observed.attributes.allRoutesPresent).toMatchObject({ state: "known", value: true });
    expect(observed.attributes.attachedToPlatformGateway).toMatchObject({ state: "known", value: true });
    // without the verified set the same node is looked up under its managed name and is missing
    const missing = await driver.observe!(driverCtx({ ...s, customDomains: undefined }), lbFor(HOST), undefined);
    expect(missing.presence).toBe("missing");
  });
});

describe("tenant object stores in the managed render and apply", () => {
  const OS = mkNode("object_store/media", "object_store", { versioning: true, publicAccess: false });
  const ports = () => ({ admin: new FakeAdmin(), sink: new MemorySink(), store: new MemoryKeyStore(TENANT.workspaceId, TENANT.environmentId) });

  it("stays unsupported (exactly as before) without an IAM-admin credential reference", () => {
    const plain = substrate({ ...FULL_ENV });
    expect(assessZenithGraph([OS]).unsupported.map((u) => u.kind)).toEqual(["object_store"]);
    expect(() => render([OS], { substrate: plain })).toThrow(/cannot realize.*object_store/);
  });

  it("renders an intent, not a manifest, when scoped credentials are available", () => {
    expect(assessZenithGraph([OS], { objectStorage: true }).storage.map((n) => n.address)).toEqual(["object_store/media"]);
    const r = render([OS]);
    expect(r.storage).toHaveLength(1);
    expect(r.storage[0]).toEqual(storageIntentFromNode(TENANT, SUB, OS));
    expect(r.workloads).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/secretAccessKey|AKIA/);
    expect(r.notes.join("\n")).toMatch(/prefix of the shared platform bucket/);
  });

  it("enforces the tier's object-store allowance", () => {
    expect(() => render([OS], { tenant: { ...TENANT, planTier: "free" } })).toThrow(/free plan allows 0 object store/);
    const three = ["a", "b", "c"].map((n) => mkNode(`object_store/${n}`, "object_store", {}));
    expect(() => render(three)).toThrow(/starter plan allows 2 object store/);
    expect(render(three.slice(0, 2)).storage).toHaveLength(2);
  });

  it("provisions before anything is applied to the cluster, and no secret reaches a manifest or the report", async () => {
    const p = ports();
    const toolkit = new FakeToolkit();
    const seenAtFirstApply: number[] = [];
    const original = toolkit.apply.bind(toolkit);
    toolkit.apply = async (...args: Parameters<typeof toolkit.apply>) => { seenAtFirstApply.push(p.admin.principals.size); return original(...args); };
    const report = await applyZenithEnvironment({
      session: session(unavailableDatabaseProvider("none"), { storage: p }, { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF }),
      expect: { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId }, toolkit, tlsClient: new FakeTlsClient(), nodes: [WEB, OS], resolveSecret: async () => undefined,
    });
    expect(report.ok).toBe(true);
    expect(report.storage).toMatchObject([{ status: "created", address: "object_store/media" }]);
    expect(seenAtFirstApply[0]).toBe(1);
    const secrets = p.admin.allSecrets();
    expect(secrets.length).toBe(1);
    expect(JSON.stringify(toolkit.applyCalls)).not.toContain(secrets[0]);
    expect(JSON.stringify(report)).not.toContain(secrets[0]);
    expect(p.sink.values.get(report.storage[0].secretRef)).toBe(secrets[0]);
  });

  it("stops before touching the cluster when storage cannot be provisioned, naming why", async () => {
    const toolkit = new FakeToolkit();
    const noPorts = await applyZenithEnvironment({
      session: session(unavailableDatabaseProvider("none"), {}, { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF }),
      expect: { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId }, toolkit, tlsClient: new FakeTlsClient(), nodes: [WEB, OS], resolveSecret: async () => undefined,
    });
    expect(noPorts).toMatchObject({ ok: false, blockedBy: "storage", storage: [{ status: "failed", error: { code: "unavailable" } }] });
    expect(toolkit.applyCalls).toEqual([]);

    const p = ports();
    p.admin.available = { available: false, reason: "admin credential not readable" };
    const down = await applyZenithEnvironment({
      session: session(unavailableDatabaseProvider("none"), { storage: p }, { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF }),
      expect: { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId }, toolkit, tlsClient: new FakeTlsClient(), nodes: [WEB, OS], resolveSecret: async () => undefined,
    });
    expect(down.storage[0].error?.message).toBe("admin credential not readable");
    expect(toolkit.applyCalls).toEqual([]);
  });

  it("a dry run plans the store and calls no provider", async () => {
    const p = ports();
    const report = await applyZenithEnvironment({
      session: session(unavailableDatabaseProvider("none"), { storage: p }, { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF }),
      expect: { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId }, toolkit: new FakeToolkit(), tlsClient: new FakeTlsClient(), nodes: [WEB, OS], resolveSecret: async () => undefined, dryRun: true,
    });
    expect(report.storage[0].status).toBe("planned");
    expect(p.admin.calls).toEqual([]);
  });

  describe("the object_store driver", () => {
    const toolkit = new FakeToolkit();
    const driverOf = () => createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers.find((d) => d.kind === "object_store")!;
    const env = { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: ADMIN_REF };

    it("reports missing before provisioning, then present and scoped, and fails verification when the scope or key is wrong", async () => {
      const p = ports();
      const s = session(unavailableDatabaseProvider("none"), { storage: p }, env);
      const driver = driverOf();
      expect((await driver.observe!(driverCtx(s), OS, undefined)).presence).toBe("missing");

      await applyZenithEnvironment({ session: s, expect: { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId }, toolkit: new FakeToolkit(), tlsClient: new FakeTlsClient(), nodes: [OS], resolveSecret: async () => undefined });
      const observed = await driver.observe!(driverCtx(s), OS, undefined);
      expect(observed.presence).toBe("present");
      expect(observed.attributes).toMatchObject({ provisioned: { value: true }, scoped: { value: true }, credentialActive: { value: true } });
      const verdict = await driver.verify!(driverCtx(s), OS, observed, undefined as never);
      expect(verdict.status).toBe("passed");
      const secret = p.admin.allSecrets()[0];
      const keyId = [...p.admin.principals.values()][0].keys.keys().next().value as string;
      expect(JSON.stringify(observed)).not.toContain(secret);
      expect(JSON.stringify(observed)).not.toContain(keyId);

      const intent = storageIntentFromNode(TENANT, s.substrate, OS);
      p.admin.principals.get(intent.principalName)!.policy!.Statement[0].Resource = ["arn:aws:s3:::*"];
      const widened = await driver.observe!(driverCtx(s), OS, undefined);
      expect(widened.attributes.scoped).toMatchObject({ value: false });
      expect((await driver.verify!(driverCtx(s), OS, widened, undefined as never)).status).toBe("failed");

      p.admin.principals.get(intent.principalName)!.keys.clear();
      const keyless = await driver.observe!(driverCtx(s), OS, undefined);
      expect(keyless.attributes.credentialActive).toMatchObject({ value: false });
      expect((await driver.verify!(driverCtx(s), OS, keyless, undefined as never)).status).toBe("failed");
    });

    it("keeps its original refusal when scoped credentials are not available", async () => {
      const plain = session(unavailableDatabaseProvider("none"), {}, FULL_ENV);
      const driver = driverOf();
      const observed = await driver.observe!(driverCtx(plain), OS, undefined);
      expect(observed.presence).toBe("unknown");
      expect(observed.error).toMatch(/per-tenant, prefix-scoped credentials/);
      expect((await driver.verify!(driverCtx(plain), OS, observed, undefined as never)).status).toBe("failed");
    });
  });
});

describe("autoscaling policy", () => {
  class HpaToolkit extends FakeToolkit {
    override renderGraph(nodes: readonly ResourceNode[], base: ToolkitRenderBase) {
      const out = super.renderGraph(nodes, base);
      if (!base.autoscale) return out;
      const extra: K8sObject[] = [];
      for (const o of out.objects) {
        if (o.kind !== "Deployment") continue;
        const replicas = Number(o.spec!.replicas ?? 1);
        if (replicas <= 1) continue;
        delete o.spec!.replicas;
        extra.push({
          apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: structuredClone(o.metadata),
          spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: o.metadata.name }, minReplicas: replicas, maxReplicas: replicas * 100, metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }] },
        });
      }
      return { ...out, objects: [...out.objects, ...extra] };
    }
  }
  const hpas = (objects: K8sObject[]) => objects.filter((o) => o.kind === "HorizontalPodAutoscaler");
  const renderWith = (tenant: ZenithTenant, autoscaling?: boolean) => renderZenithEnvironment({ tenant, substrate: SUB, nodes: [WEB], toolkit: new HpaToolkit(), autoscaling });

  it("is off unless asked for, and never part of the free tier", () => {
    expect(hpas(renderWith(TENANT).workloads)).toEqual([]);
    expect(hpas(renderWith({ ...TENANT, planTier: "free" }, true).workloads)).toEqual([]);
  });

  it("clamps maxReplicas to the tier and damps scale-down", () => {
    const [starter] = hpas(renderWith(TENANT, true).workloads);
    expect(starter.spec).toMatchObject({ minReplicas: 2, maxReplicas: 5, behavior: { scaleDown: { stabilizationWindowSeconds: 300 } } });
    const [pro] = hpas(renderWith({ ...TENANT, planTier: "pro" }, true).workloads);
    expect(pro.spec).toMatchObject({ minReplicas: 2, maxReplicas: 20 });
    // the autoscaler passes the same isolation gate as everything else, and the Deployment leaves replicas to it
    const deployment = renderWith(TENANT, true).workloads.find((o) => o.kind === "Deployment")!;
    expect(deployment.spec).not.toHaveProperty("replicas");
  });

  it("explains the clamp in the render notes", () => {
    const notes = renderWith(TENANT, true).notes.join("\n");
    expect(notes).toMatch(/autoscaling 2-5 replicas on CPU \(requested 200, limited by the starter plan quota\)/);
    expect(notes).toMatch(/metrics-server/);
  });

  describe("constrainAutoscalers", () => {
    const deployment = (cpu: string): K8sObject => ({
      apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: NS, annotations: { "zenith.dev/resource": "container_service/web" } },
      spec: { template: { spec: { containers: [{ name: "app", resources: { requests: { cpu } } }] } } },
    });
    const hpa = (spec: Record<string, unknown>, kind = "Deployment", name = "web"): K8sObject => ({
      apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler", metadata: { name: "web", namespace: NS, annotations: { "zenith.dev/resource": "container_service/web" } },
      spec: { scaleTargetRef: { apiVersion: "apps/v1", kind, name }, minReplicas: 1, maxReplicas: 100, ...spec },
    });
    const pro = { ...TENANT, planTier: "pro" as const };

    it("also clamps to what the namespace CPU request quota can hold", () => {
      const out = constrainAutoscalers([deployment("1"), hpa({})], pro);
      expect(hpas(out.objects)[0].spec).toMatchObject({ maxReplicas: 16 });
      expect(out.notes[0]).toMatch(/limited by the pro plan quota/);
      expect(hpas(constrainAutoscalers([deployment("250m"), hpa({})], pro).objects)[0].spec).toMatchObject({ maxReplicas: 20 });
    });

    it("never raises a smaller request and does not mutate its input", () => {
      const input = [deployment("100m"), hpa({ maxReplicas: 3 })];
      const frozen = structuredClone(input);
      expect(hpas(constrainAutoscalers(input, TENANT).objects)[0].spec).toMatchObject({ maxReplicas: 3 });
      expect(input).toEqual(frozen);
    });

    it("refuses an autoscaler on the free tier, a minimum above the ceiling, and a target that is not a rendered Deployment", () => {
      expect(() => constrainAutoscalers([deployment("100m"), hpa({})], { ...TENANT, planTier: "free" })).toThrow(/not part of the free plan/);
      expect(() => constrainAutoscalers([deployment("100m"), hpa({ minReplicas: 9 })], TENANT)).toThrow(/minimum replicas do not fit/);
      expect(() => constrainAutoscalers([deployment("100m"), hpa({}, "StatefulSet")], TENANT)).toThrow(/only target a Deployment/);
      expect(() => constrainAutoscalers([hpa({})], TENANT)).toThrow(/only target a Deployment/);
    });

    it("reads CPU quantities", () => {
      expect([cpuMillis("100m"), cpuMillis("1"), cpuMillis("0.5"), cpuMillis(2), cpuMillis("1Gi"), cpuMillis(undefined)]).toEqual([100, 1000, 500, 2000, undefined, undefined]);
    });
  });
});

describe("no plaintext secret in a manifest", () => {
  const rendered = render([WEB, lbFor("web.production.acme.apps.example.com")]);
  const deployment = rendered.workloads.find((o) => o.kind === "Deployment")!;
  const withEnv = (env: unknown[], extra: Record<string, unknown> = {}): K8sObject => {
    const clone = structuredClone(deployment);
    const container = (clone.spec!.template as { spec: { containers: Record<string, unknown>[] } }).spec.containers[0];
    container.env = env;
    Object.assign(container, extra);
    return clone;
  };
  const rules = (o: K8sObject) => validateTenantObjects([o], { tenant: TENANT, substrate: SUB }).map((v) => v.rule);

  it("passes what the renderer emits", () => {
    expect(validateTenantObjects(rendered.workloads, { tenant: TENANT, substrate: SUB })).toEqual([]);
  });

  it("refuses a literal under a secret-named variable, a credential-shaped value anywhere, and a secret on the command line", () => {
    expect(rules(withEnv([{ name: "DB_PASSWORD", value: "hunter2" }]))).toContain("secret_value");
    expect(rules(withEnv([{ name: "STRIPE_API_KEY", value: "x" }]))).toContain("secret_value");
    expect(rules(withEnv([{ name: "DATABASE_URL", value: "postgres://app:s3cret@db.internal/app" }]))).toContain("secret_value");
    expect(rules(withEnv([{ name: "NOTE", value: "postgres://app:s3cret@db.internal/app" }]))).toContain("secret_value");
    expect(rules(withEnv([{ name: "SOMETHING", value: "AKIA" + "ABCDEFGHIJKLMNOP" }]))).toContain("secret_value");
    expect(rules(withEnv([], { args: ["--token", "Bearer abcdefghijklmnopqrstuvwxyz0123456789"] }))).toContain("secret_value");
  });

  it("allows references and ordinary values", () => {
    expect(rules(withEnv([{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }, { name: "LOG_LEVEL", value: "debug" }, { name: "PORT", value: "8080" }]))).toEqual([]);
    expect(rules(withEnv([{ name: "TOKEN", value: "" }]))).toEqual([]);
  });

  it("the finding names the variable and never echoes its value", () => {
    const v = validateTenantObjects([withEnv([{ name: "DB_PASSWORD", value: "hunter2-canary" }])], { tenant: TENANT, substrate: SUB });
    expect(JSON.stringify(v)).toContain("DB_PASSWORD");
    expect(JSON.stringify(v)).not.toContain("hunter2-canary");
  });
});
