import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KubernetesSession } from "@/lib/credentials/types";
import { findDriver, getDriver, listDrivers, type DriverContext, type ResourceDriver } from "@/lib/drivers/types";
import { NATIVE_TYPE_TABLE, nativeTypeFor } from "@/lib/resources/native-types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { createZenithDrivers, registerZenithDrivers, zenithDriverId } from "@/lib/providers/zenith/drivers";
import { OBJECT_STORE_UNSUPPORTED_REASON, PROPOSED_OBJECT_STORE_NATIVE_TYPE } from "@/lib/providers/zenith/drivers/data/object-store";
import { createNeonProvider } from "@/lib/providers/zenith/neon";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { routeObjectName } from "@/lib/providers/zenith/routing";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { TENANCY_OBJECTS } from "@/lib/providers/zenith/types";
import { unavailableDatabaseProvider, managedDatabaseConnectionRef } from "@/lib/providers/zenith/database";
import {
  DB,
  DB_PASSWORD,
  DNS,
  FULL_ENV,
  FW_LB_TO_WEB,
  FW_PUBLIC,
  FW_WEB_TO_DB,
  FW_WEB_TO_WORKER,
  FakeNeon,
  FakeToolkit,
  K8S_SESSION,
  LB,
  MemorySink,
  NEON_KEY,
  NET,
  NS,
  TENANT,
  TLS,
  TYPICAL_GRAPH,
  WEB,
  driverCtx,
  mkNode,
  resolver,
  session,
  substrate,
} from "./support";

/* ------------------------------ fake k8s drivers ---------------------------- */

interface Seen {
  method: string;
  ctx: DriverContext<KubernetesSession>;
  node: ResourceNode;
  input?: Record<string, unknown>;
}

/** Stands in for a Kubernetes-provider driver: records what it was handed and claims `real` evidence it did not earn. */
function fakeBase(nativeType: string, kind: ResourceDriver["kind"], seen: Seen[]): ResourceDriver<KubernetesSession> {
  const ops = { "service.restart": "service.restart" };
  return {
    id: `kubernetes.${nativeType.replace(/^k8s:/, "").toLowerCase()}@1`,
    provider: "kubernetes",
    kind,
    nativeType,
    capabilities: {
      compile: false,
      observe: true,
      runtime: true,
      verify: true,
      discover: true,
      operations: Object.keys(ops),
      evidence: { observe: "real", runtime: "real", verify: "emulated", "service.restart": "real" },
    },
    async observe(ctx, node) {
      seen.push({ method: "observe", ctx, node });
      return { address: node.address, presence: "present", attributes: {}, native: { base: true }, observedAt: "x", source: "kubernetes.base@1", simulated: false };
    },
    async runtime(ctx, node) {
      seen.push({ method: "runtime", ctx, node });
      return { address: node.address, health: "healthy", counts: {}, signals: [], observedAt: "x", source: "kubernetes.base@1", simulated: false };
    },
    async verify(ctx, node) {
      seen.push({ method: "verify", ctx, node });
      return { address: node.address, status: "passed", checks: [], checkedAt: "x", simulated: false };
    },
    async discover() {
      return [];
    },
    expectedAttributes: () => ({ replicas: 2 }),
    operations: {
      "service.restart": async (ctx, node, input) => {
        seen.push({ method: "service.restart", ctx, node, input });
        return { ok: true, summary: "restarted", simulated: false };
      },
    },
  };
}

const BASE_TYPES: [string, ResourceDriver["kind"]][] = [
  ["k8s:Deployment", "container_service"],
  ["k8s:CronJob", "scheduled_job"],
  ["k8s:Secret", "secret"],
  ["k8s:ServiceAccount", "identity"],
  ["k8s:PersistentVolumeClaim", "volume"],
  ["k8s:NetworkPolicy", "firewall"],
  ["k8s:Ingress", "load_balancer"],
];

let neon: FakeNeon;
let sink: MemorySink;
let toolkit: FakeToolkit;
let seen: Seen[];

beforeEach(async () => {
  neon = new FakeNeon();
  await neon.start();
  sink = new MemorySink();
  toolkit = new FakeToolkit();
  seen = [];
});
afterEach(async () => {
  await neon.stop();
});

const bases = () => BASE_TYPES.map(([t, k]) => fakeBase(t, k, seen));
const byType = (set: ResourceDriver<ZenithSession>[], t: string) => set.find((d) => d.nativeType === t)!;
const neonProvider = () =>
  createNeonProvider({ provider: "neon", apiBase: neon.url, apiKeyRef: "vault:zenith-managed/neon-api-key", regionId: "aws-us-east-2", egress: [] }, { fetch: (i, n) => fetch(i, n), resolveSecret: resolver("vault:zenith-managed/neon-api-key", NEON_KEY), sink, timeoutMs: 3000 });

function seedBaseline(over: { dropQuota?: boolean; dropDeny?: boolean; pss?: string; planTier?: ZenithSession["tenant"]["planTier"] } = {}): void {
  const r = renderZenithEnvironment({ tenant: { ...TENANT, planTier: over.planTier ?? TENANT.planTier }, substrate: substrate(), nodes: [], toolkit });
  for (const o of r.baseline) {
    if (over.dropQuota && o.kind === "ResourceQuota") continue;
    if (over.dropDeny && o.metadata.name === TENANCY_OBJECTS.defaultDeny) continue;
    const copy = structuredClone(o);
    if (over.pss && o.kind === "Namespace") copy.metadata.labels!["pod-security.kubernetes.io/enforce"] = over.pss;
    if (o.kind === "Namespace") (copy as Record<string, unknown>).status = { phase: "Active" };
    toolkit.put(copy);
  }
}

const obs = async (d: ResourceDriver<ZenithSession>, node: ResourceNode, s = session(unavailableDatabaseProvider("x")), ctx = driverCtx(s)): Promise<Observation> => d.observe!(ctx, node);

/* -------------------------------- registration ------------------------------ */

describe("registration under provider zenith", () => {
  it("registers a driver for every native type the contract table gives zenith for the kinds it realizes", () => {
    const set = registerZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    expect(set.missingKubernetesDrivers).toEqual([]);
    const realized = ["network", "kubernetes_namespace", "firewall", "load_balancer", "dns_record", "tls_certificate", "container_service", "static_site", "scheduled_job", "postgres", "mysql", "redis", "secret", "identity", "volume"] as const;
    for (const kind of realized) {
      const t = nativeTypeFor("zenith", kind)!;
      const d = getDriver("zenith", t);
      expect(d.provider).toBe("zenith");
      expect(d.nativeType).toBe(t);
    }
  });

  it("the native types are exactly the Kubernetes row (the contract's `zenith` row equals the Kubernetes row)", () => {
    expect(NATIVE_TYPE_TABLE.zenith).toEqual(NATIVE_TYPE_TABLE.kubernetes);
  });

  it("registers the zenith drivers without touching the kubernetes provider's registry entries", () => {
    const k = fakeBase("k8s:Deployment", "container_service", seen);
    // the registry is keyed by (provider, nativeType): zenith's Deployment driver is a different entry
    registerZenithDrivers({ toolkit, kubernetesDrivers: [k] });
    expect(getDriver("zenith", "k8s:Deployment").id).toBe("zenith.deployment@1");
    expect(findDriver("kubernetes", "k8s:Deployment")).toBeUndefined();
  });

  it("is idempotent", () => {
    registerZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    const before = listDrivers("zenith").length;
    registerZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    expect(listDrivers("zenith")).toHaveLength(before);
  });

  it("gives every driver a zenith id, the zenith provider, and `contract` evidence at best", () => {
    const { drivers } = createZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    for (const d of drivers) {
      expect(d.id).toMatch(/^zenith\.[a-z0-9_]+@1$/);
      expect(d.provider).toBe("zenith");
      expect(Object.values(d.capabilities.evidence).every((e) => e === "contract"), d.id).toBe(true);
      expect(d.capabilities.compile).toBe(false);
      expect(d.capabilities.discover).toBe(false);
      expect(d.discover).toBeUndefined();
      expect(d.compile).toBeUndefined();
    }
  });

  it("declares evidence for every claim it makes, and only those", () => {
    const { drivers } = createZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    for (const d of drivers) {
      const c = d.capabilities;
      const claimed = [...(c.observe ? ["observe"] : []), ...(c.runtime ? ["runtime"] : []), ...(c.verify ? ["verify"] : []), ...c.operations].sort();
      expect(Object.keys(c.evidence).sort(), d.id).toEqual(claimed);
      expect(Boolean(d.observe)).toBe(c.observe);
      expect(Boolean(d.runtime)).toBe(c.runtime);
      expect(Boolean(d.verify)).toBe(c.verify);
    }
  });

  it("reports the Kubernetes drivers it could not wrap instead of registering stubs", () => {
    const set = createZenithDrivers({ toolkit, kubernetesDrivers: [fakeBase("k8s:Deployment", "container_service", seen)] });
    expect(set.missingKubernetesDrivers.sort()).toEqual(["k8s:CronJob", "k8s:PersistentVolumeClaim", "k8s:Secret", "k8s:ServiceAccount"]);
    expect(set.drivers.some((d) => d.nativeType === "k8s:CronJob")).toBe(false);
    expect(set.drivers.some((d) => d.nativeType === "k8s:Deployment")).toBe(true);
  });

  it("derives driver ids from native types", () => {
    expect(zenithDriverId("k8s:Deployment")).toBe("zenith.deployment@1");
    expect(zenithDriverId("k8s:PersistentVolumeClaim")).toBe("zenith.persistentvolumeclaim@1");
  });

  it("has the postgres driver on the contract's postgres native type, and the object store on a type of its own", () => {
    const { drivers } = createZenithDrivers({ toolkit, kubernetesDrivers: [] });
    expect(drivers.find((d) => d.kind === "postgres")!.nativeType).toBe(nativeTypeFor("zenith", "postgres"));
    expect(drivers.find((d) => d.kind === "object_store")!.nativeType).toBe(nativeTypeFor("zenith", "object_store") ?? PROPOSED_OBJECT_STORE_NATIVE_TYPE);
  });
});

/* ------------------------------ the tenancy wrapper ------------------------- */

describe("wrapped Kubernetes drivers", () => {
  const wrapped = () => byType(createZenithDrivers({ toolkit, kubernetesDrivers: bases() }).drivers, "k8s:Deployment");

  it("hands the base driver the tenant-scoped Kubernetes session and a node forced into the tenant namespace", async () => {
    const d = wrapped();
    const observed = await d.observe!(driverCtx(session(unavailableDatabaseProvider("x"))), WEB);
    const call = seen.find((s) => s.method === "observe")!;
    expect(call.ctx.session).toBe(K8S_SESSION);
    expect(call.node.spec.namespace).toBe(NS);
    expect(call.node.address).toBe(WEB.address);
    expect(WEB.spec.namespace).toBeUndefined();
    expect(observed.source).toBe("zenith.deployment@1");
    expect(observed.native).toMatchObject({ base: true, delegatedTo: "kubernetes.deployment@1" });
  });

  it("overrides a namespace the node asks for", async () => {
    await wrapped().observe!(driverCtx(session(unavailableDatabaseProvider("x"))), mkNode("container_service/web", "container_service", { ...WEB.spec, namespace: "kube-system" }));
    expect(seen[0].node.spec.namespace).toBe(NS);
  });

  it("refuses a session opened for another workspace or environment, on every method", async () => {
    const d = wrapped();
    const s = session(unavailableDatabaseProvider("x"));
    const foreignWorkspace = driverCtx(s, { workspaceId: "ws_other" });
    const foreignEnv = driverCtx(s, { environmentId: "env_other" });
    for (const ctx of [foreignWorkspace, foreignEnv]) {
      await expect(d.observe!(ctx, WEB)).rejects.toMatchObject({ code: "tenant_mismatch" });
      await expect(d.runtime!(ctx, WEB)).rejects.toMatchObject({ code: "tenant_mismatch" });
      await expect(d.verify!(ctx, WEB, {} as Observation)).rejects.toMatchObject({ code: "tenant_mismatch" });
      await expect(d.operations!["service.restart"](ctx, WEB, {})).rejects.toMatchObject({ code: "tenant_mismatch" });
    }
    expect(seen).toHaveLength(0);
  });

  it("strips any namespace from operation input and passes the rest through", async () => {
    const r = await wrapped().operations!["service.restart"](driverCtx(session(unavailableDatabaseProvider("x"))), WEB, { namespace: "kube-system", reason: "deploy" });
    expect(r.ok).toBe(true);
    const call = seen.find((s) => s.method === "service.restart")!;
    expect(call.input).toEqual({ reason: "deploy" });
    expect(call.node.spec.namespace).toBe(NS);
  });

  it("delegates runtime, verify and expected attributes", async () => {
    const d = wrapped();
    const ctx = driverCtx(session(unavailableDatabaseProvider("x")));
    expect((await d.runtime!(ctx, WEB)).health).toBe("healthy");
    expect((await d.runtime!(ctx, WEB)).source).toBe("zenith.deployment@1");
    expect((await d.verify!(ctx, WEB, {} as Observation)).status).toBe("passed");
    expect(d.expectedAttributes!(WEB)).toEqual({ replicas: 2 });
  });

  it("downgrades the base driver's claimed evidence to contract and drops discovery", () => {
    const d = wrapped();
    expect(d.capabilities.evidence).toEqual({ observe: "contract", runtime: "contract", verify: "contract", "service.restart": "contract" });
    expect(d.capabilities.discover).toBe(false);
    expect(d.capabilities.operations).toEqual(["service.restart"]);
  });
});

/* ---------------------------- tenant namespace driver ----------------------- */

describe("zenith.tenant_namespace@1", () => {
  const driver = () => byType(createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers, "k8s:Namespace");
  const s = () => session(unavailableDatabaseProvider("x"));

  it("serves both namespace kinds under the contract's native type", () => {
    expect(nativeTypeFor("zenith", "network")).toBe("k8s:Namespace");
    expect(nativeTypeFor("zenith", "kubernetes_namespace")).toBe("k8s:Namespace");
    expect(driver().id).toBe("zenith.tenant_namespace@1");
  });

  it("reports the baseline present and verified when the cluster holds all of it", async () => {
    seedBaseline();
    const d = driver();
    const o = await obs(d, NET, s());
    expect(o.presence).toBe("present");
    expect(o.externalId).toBe(NS);
    for (const [k, v] of Object.entries(d.expectedAttributes!(NET))) expect(o.attributes[k], k).toMatchObject({ state: "known", value: v });
    const v = await d.verify!(driverCtx(s()), NET, o);
    expect(v.status).toBe("passed");
    expect(v.simulated).toBe(false);
  });

  it("is missing when the namespace does not exist", async () => {
    const o = await obs(driver(), NET, s());
    expect(o.presence).toBe("missing");
    expect((await driver().verify!(driverCtx(s()), NET, o)).status).toBe("failed");
  });

  it("fails verification when the default-deny policy is gone", async () => {
    seedBaseline({ dropDeny: true });
    const d = driver();
    const o = await obs(d, NET, s());
    expect(o.attributes.defaultDenyPresent).toMatchObject({ state: "known", value: false });
    expect((await d.verify!(driverCtx(s()), NET, o)).status).toBe("failed");
  });

  it("fails verification when the quota is missing or no longer matches the plan", async () => {
    seedBaseline({ dropQuota: true });
    const d = driver();
    expect((await d.verify!(driverCtx(s()), NET, await obs(d, NET, s()))).status).toBe("failed");
    toolkit.store.clear();
    seedBaseline({ planTier: "free" }); // the cluster still holds the free quota while the tenant is on starter
    const o = await obs(d, NET, s());
    expect(o.attributes.quotaMatchesPlan).toMatchObject({ state: "known", value: false });
    expect((await d.verify!(driverCtx(s()), NET, o)).status).toBe("failed");
  });

  it("fails verification when the namespace only enforces the baseline Pod Security Standard", async () => {
    seedBaseline({ pss: "baseline" });
    const d = driver();
    const o = await obs(d, NET, s());
    expect(o.attributes.podSecurityEnforce).toMatchObject({ value: "baseline" });
    expect((await d.verify!(driverCtx(s()), NET, o)).status).toBe("failed");
  });

  it("reports inaccessible on a forbidden read and unknown on any other error, never missing", async () => {
    toolkit.readError = Object.assign(new Error("forbidden: secrets is forbidden"), { code: "forbidden" });
    expect((await obs(driver(), NET, s())).presence).toBe("inaccessible");
    toolkit.readError = Object.assign(new Error("connection reset"), { code: "unreachable" });
    const o = await obs(driver(), NET, s());
    expect(o.presence).toBe("unknown");
    expect(o.error).toMatch(/connection reset/);
  });

  it("reads runtime health from the namespace phase", async () => {
    seedBaseline();
    const d = driver();
    expect((await d.runtime!(driverCtx(s()), NET)).health).toBe("healthy");
    toolkit.store.clear();
    expect((await d.runtime!(driverCtx(s()), NET)).health).toBe("unhealthy");
  });

  it("refuses another tenant's session", async () => {
    await expect(driver().observe!(driverCtx(s(), { workspaceId: "ws_other" }), NET)).rejects.toMatchObject({ code: "tenant_mismatch" });
  });
});

/* ---------------------------------- routes ---------------------------------- */

describe("zenith.http_route@1", () => {
  const driver = () => byType(createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers, "k8s:Ingress");
  const s = () => session(unavailableDatabaseProvider("x"));
  const HOST = "web.production.acme.apps.example.com";
  const route = (over: { parent?: Record<string, unknown>; conditions?: { type: string; status: string }[] | null } = {}) => ({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: routeObjectName(HOST), namespace: NS, labels: { "zenith.dev/route": "true" } },
    spec: { hostnames: [HOST], parentRefs: [over.parent ?? { name: "zenith-gateway", namespace: "zenith-gateway", kind: "Gateway" }] },
    ...(over.conditions === null
      ? {}
      : { status: { parents: [{ conditions: over.conditions ?? [{ type: "Accepted", status: "True" }, { type: "ResolvedRefs", status: "True" }] }] } }),
  });

  it("is registered under the contract's load balancer native type", () => {
    expect(nativeTypeFor("zenith", "load_balancer")).toBe("k8s:Ingress");
    expect(driver().id).toBe("zenith.http_route@1");
  });

  it("is present, accepted and attached when the route exists and the gateway accepted it", async () => {
    toolkit.put(route());
    const d = driver();
    const o = await obs(d, LB, s());
    expect(o.presence).toBe("present");
    for (const [k, v] of Object.entries(d.expectedAttributes!(LB))) expect(o.attributes[k], k).toMatchObject({ state: "known", value: v });
    expect((await d.verify!(driverCtx(s()), LB, o)).status).toBe("passed");
    expect((await d.runtime!(driverCtx(s()), LB)).health).toBe("healthy");
  });

  it("is missing when there is no route, and says which hosts it expected", async () => {
    const o = await obs(driver(), LB, s());
    expect(o.presence).toBe("missing");
    expect(o.native).toMatchObject({ expectedHosts: [HOST] });
  });

  it("does not claim acceptance before the gateway controller has reported", async () => {
    toolkit.put(route({ conditions: null }));
    const d = driver();
    const o = await obs(d, LB, s());
    expect(o.attributes.allRoutesAccepted).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect((await d.verify!(driverCtx(s()), LB, o)).status).toBe("unknown");
    expect((await d.runtime!(driverCtx(s()), LB)).health).toBe("unknown");
  });

  it("fails verification and degrades runtime when the route is not accepted", async () => {
    toolkit.put(route({ conditions: [{ type: "Accepted", status: "False" }] }));
    const d = driver();
    const o = await obs(d, LB, s());
    expect(o.attributes.allRoutesAccepted).toMatchObject({ value: false });
    expect((await d.verify!(driverCtx(s()), LB, o)).status).toBe("failed");
    expect((await d.runtime!(driverCtx(s()), LB)).health).toBe("degraded");
  });

  it("detects a route attached to some other gateway", async () => {
    toolkit.put(route({ parent: { name: "other", namespace: "elsewhere", kind: "Gateway" } }));
    const o = await obs(driver(), LB, s());
    expect(o.attributes.attachedToPlatformGateway).toMatchObject({ value: false });
  });

  it("reports a partial set of routes as not all present", async () => {
    const lb = mkNode("load_balancer/public", "load_balancer", { ...LB.spec, routes: [{ host: "a.customer.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }, { host: "b.customer.com", pathPrefix: "/", tls: true, target: "container_service/worker", port: 9000 }] });
    toolkit.put(route());
    const o = await obs(driver(), lb, s());
    expect(o.presence).toBe("present");
    expect(o.attributes.allRoutesPresent).toMatchObject({ value: false });
    expect(o.attributes.allRoutesAccepted).toMatchObject({ value: false });
    expect(o.native).toMatchObject({ missingHosts: ["worker.production.acme.apps.example.com"] });
  });

  it("delegates to the Ingress driver in ingress mode, and says so when there is none", async () => {
    const ingressEnv = { ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" };
    const sIngress = session(unavailableDatabaseProvider("x"), {}, ingressEnv);
    const withBase = byType(createZenithDrivers({ toolkit, kubernetesDrivers: bases() }).drivers, "k8s:Ingress");
    await withBase.observe!(driverCtx(sIngress), LB);
    expect(seen.find((x) => x.method === "observe")!.node.kind).toBe("load_balancer");
    const without = driver();
    const o = await without.observe!(driverCtx(sIngress), LB);
    expect(o.presence).toBe("unknown");
    expect(o.attributes.allRoutesPresent).toMatchObject({ state: "unknown", reason: "not_supported" });
  });

  it("refuses another tenant's session", async () => {
    await expect(driver().observe!(driverCtx(s(), { environmentId: "env_other" }), LB)).rejects.toMatchObject({ code: "tenant_mismatch" });
  });
});

/* ------------------------------- dns and tls -------------------------------- */

describe("platform-managed dns_record and tls_certificate", () => {
  const set = () => createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers;
  const dns = () => byType(set(), "k8s:DNSEndpoint");
  const tls = () => byType(set(), "k8s:Certificate");
  const s = () => session(unavailableDatabaseProvider("x"));
  const routeFor = (sources: string) => ({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: "route-x", namespace: NS, labels: { "zenith.dev/route": "true" }, annotations: { "zenith.dev/source-hosts": sources } },
    spec: { hostnames: ["web.production.acme.apps.example.com"] },
  });

  it("are registered under the contract's native types and render and create nothing", () => {
    expect(dns().id).toBe("zenith.platform_dns@1");
    expect(tls().id).toBe("zenith.platform_tls@1");
    for (const d of [dns(), tls()]) {
      expect(d.compile).toBeUndefined();
      expect(d.operations).toBeUndefined();
      expect(d.capabilities.operations).toEqual([]);
    }
  });

  it("observe returns present, platform-managed, when a managed route stands in for the host", async () => {
    toolkit.put(routeFor("other.customer.com,app.customer.com"));
    for (const [d, node] of [[dns(), DNS], [tls(), TLS]] as const) {
      const o = await obs(d, node, s());
      expect(o.presence, d.id).toBe("present");
      expect(o.attributes.platformManaged).toMatchObject({ state: "known", value: true });
      expect(o.externalId).toBe("web.production.acme.apps.example.com");
      expect(o.native).toMatchObject({ platformManaged: true, sourceHost: node.kind === "dns_record" ? "app.customer.com" : "app.customer.com" });
      expect((await d.verify!(driverCtx(s()), node, o)).status).toBe("passed");
    }
  });

  it("is missing when no route serves the host, and does not match a different host", async () => {
    toolkit.put(routeFor("someone-else.customer.com"));
    const o = await obs(dns(), DNS, s());
    expect(o.presence).toBe("missing");
    expect((await dns().verify!(driverCtx(s()), DNS, o)).status).toBe("failed");
  });

  it("does not match a host that only contains the name as a substring", async () => {
    toolkit.put(routeFor("xapp.customer.com,app.customer.com.evil.net"));
    expect((await obs(dns(), DNS, s())).presence).toBe("missing");
  });

  it("claims absence only when the whole route list was read", async () => {
    toolkit.listTruncated = true;
    const o = await obs(dns(), DNS, s());
    expect(o.presence).toBe("unknown");
    expect(o.error).toMatch(/truncated/);
  });

  it("is unknown, not missing, when the cluster does not serve the routing kind", async () => {
    toolkit.listUnavailable = true;
    const o = await obs(tls(), TLS, s());
    expect(o.presence).toBe("unknown");
    expect(o.attributes.platformManaged).toMatchObject({ state: "unknown", reason: "not_supported" });
  });

  it("only looks in the tenant's own namespace", async () => {
    toolkit.put({ ...routeFor("app.customer.com"), metadata: { name: "route-x", namespace: "zt-someone-else-0000000000", labels: { "zenith.dev/route": "true" }, annotations: { "zenith.dev/source-hosts": "app.customer.com" } } });
    expect((await obs(dns(), DNS, s())).presence).toBe("missing");
  });

  it("refuses another tenant's session", async () => {
    await expect(dns().observe!(driverCtx(s(), { workspaceId: "ws_other" }), DNS)).rejects.toMatchObject({ code: "tenant_mismatch" });
  });
});

/* --------------------------------- firewalls -------------------------------- */

describe("zenith.network_policy@1", () => {
  const driver = (withBase = true) => byType(createZenithDrivers({ toolkit, kubernetesDrivers: withBase ? bases() : [] }).drivers, "k8s:NetworkPolicy");
  const s = () => session(unavailableDatabaseProvider("x"));

  it("answers platform-managed rules from the tenancy baseline, without asking the Kubernetes driver", async () => {
    seedBaseline();
    for (const fw of [FW_PUBLIC, FW_LB_TO_WEB, FW_WEB_TO_DB]) {
      const o = await obs(driver(), fw, s());
      expect(o.presence, fw.address).toBe("present");
      expect(o.attributes.platformManaged).toMatchObject({ value: true });
      expect(o.externalId).toBe(`${NS}/${TENANCY_OBJECTS.allowPlatform}`);
    }
    expect(seen).toHaveLength(0);
  });

  it("is missing when the baseline policy is gone", async () => {
    expect((await obs(driver(), FW_PUBLIC, s())).presence).toBe("missing");
  });

  it("delegates binding-derived rules to the Kubernetes driver", async () => {
    await obs(driver(), FW_WEB_TO_WORKER, s());
    expect(seen.map((x) => x.method)).toEqual(["observe"]);
    expect(seen[0].node.spec.namespace).toBe(NS);
  });

  it("says it cannot observe a binding rule when no Kubernetes driver was supplied", async () => {
    const o = await obs(driver(false), FW_WEB_TO_WORKER, s());
    expect(o.presence).toBe("unknown");
    expect(o.error).toMatch(/No Kubernetes NetworkPolicy driver/);
  });

  it("refuses another tenant's session", async () => {
    await expect(driver().observe!(driverCtx(s(), { environmentId: "env_other" }), FW_PUBLIC)).rejects.toMatchObject({ code: "tenant_mismatch" });
  });
});

/* ---------------------------------- postgres -------------------------------- */

describe("zenith.managed_postgres@1", () => {
  const driver = () => byType(createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers, nativeTypeFor("zenith", "postgres")!);
  const REF = managedDatabaseConnectionRef(TENANT.environmentId, DB.address);

  async function provisioned() {
    const p = neonProvider();
    const made = await p.create({ workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, address: DB.address, engineVersion: 16, size: "small", backup: "none", highAvailability: false, deletionPolicy: "deny" });
    if (!made.ok) throw new Error(made.error.message);
    return { p, id: made.value.externalId };
  }

  it("is the driver for the contract's postgres native type, and never a StatefulSet driver", () => {
    expect(driver().kind).toBe("postgres");
    expect(driver().id).toBe("zenith.managed_postgres@1");
    expect(driver().compile).toBeUndefined();
  });

  it("observes a provisioned database: engine version, provider, and only a connection secret REFERENCE", async () => {
    const { p } = await provisioned();
    const d = driver();
    const o = await obs(d, DB, session(p));
    expect(o.presence).toBe("present");
    expect(o.attributes.engineVersion).toMatchObject({ state: "known", value: 16 });
    expect(o.attributes.managedByZenith).toMatchObject({ value: true });
    expect(o.attributes.computeState).toMatchObject({ value: "active" });
    expect(o.native).toMatchObject({ provider: "neon", connectionSecretRef: REF });
    const text = JSON.stringify(o);
    for (const canary of [DB_PASSWORD, NEON_KEY, "postgresql://", "neon.tech", "app_owner", "ep-quiet"]) expect(text, canary).not.toContain(canary);
  });

  it("verifies a healthy database as passed, and expected attributes match what observe reads", async () => {
    const { p } = await provisioned();
    const d = driver();
    const o = await obs(d, DB, session(p));
    const expected = d.expectedAttributes!(DB);
    expect(expected).toEqual({ managedByZenith: true, engineVersion: 16 });
    for (const k of Object.keys(expected)) expect(o.attributes[k].state).toBe("known");
    const v = await d.verify!(driverCtx(session(p)), DB, o);
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(["exists", "attr:managedByZenith", "attr:engineVersion", "serving"]);
  });

  it("fails verification when the engine version differs from the desired one", async () => {
    const { p } = await provisioned();
    const d = driver();
    const v15 = mkNode("postgres/db", "postgres", { ...DB.spec, version: "17" });
    const o = await obs(d, v15, session(p));
    expect((await d.verify!(driverCtx(session(p)), v15, o)).status).toBe("failed");
  });

  it("is missing when no project exists", async () => {
    const o = await obs(driver(), DB, session(neonProvider()));
    expect(o.presence).toBe("missing");
    expect((await driver().verify!(driverCtx(session(neonProvider())), DB, o)).status).toBe("failed");
  });

  it.each([
    ["active", "healthy"],
    ["idle", "healthy"],
    ["init", "degraded"],
    ["none", "unhealthy"],
    ["disabled", "unhealthy"],
  ] as const)("maps compute state %s to runtime health %s, never probing connectivity", async (state, health) => {
    const { p } = await provisioned();
    neon.endpointState = state;
    const r = await driver().runtime!(driverCtx(session(p)), DB);
    expect(r.health).toBe(health);
    expect(r.signals.join(",")).toMatch(state === "active" || state === "idle" ? /connectivity_not_probed/ : /compute_/);
  });

  it("fails the serving check when the compute is gone", async () => {
    const { p } = await provisioned();
    neon.endpointState = "none";
    const d = driver();
    const o = await obs(d, DB, session(p));
    const v = await d.verify!(driverCtx(session(p)), DB, o);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "serving")!.passed).toBe(false);
  });

  it("answers unknown, with the reason, when no managed database provider is configured", async () => {
    const o = await obs(driver(), DB, session(unavailableDatabaseProvider("Set ZENITH_MANAGED_DB_PROVIDER=neon")));
    expect(o.presence).toBe("unknown");
    expect(o.error).toMatch(/ZENITH_MANAGED_DB_PROVIDER/);
    for (const a of Object.values(o.attributes)) expect(a.state).toBe("unknown");
    const r = await driver().runtime!(driverCtx(session(unavailableDatabaseProvider("x"))), DB);
    expect(r.health).toBe("unknown");
  });

  it("reports an unauthorized provider as inaccessible, not missing", async () => {
    const bad = createNeonProvider({ provider: "neon", apiBase: neon.url, apiKeyRef: "vault:k", regionId: "r", egress: [] }, { fetch: (i, n) => fetch(i, n), resolveSecret: resolver("vault:k", "wrong"), sink, timeoutMs: 3000 });
    const o = await obs(driver(), DB, session(bad));
    expect(o.presence).toBe("inaccessible");
    expect(o.attributes.engineVersion).toMatchObject({ state: "unknown", reason: "access_denied" });
  });

  it("answers mysql and redis nodes as unsupported rather than treating them as postgres", async () => {
    for (const kind of ["redis", "mysql"] as const) {
      const n = mkNode(`${kind}/x`, kind, {});
      const o = await obs(driver(), n, session(neonProvider()));
      expect(o.presence).toBe("unknown");
      expect(o.error).toMatch(/not offered/);
      expect((await driver().verify!(driverCtx(session(neonProvider())), n, o)).status).toBe("failed");
    }
    expect(neon.requests).toHaveLength(0);
  });

  it("refuses another tenant's session and never calls the provider", async () => {
    const { p } = await provisioned();
    const before = neon.requests.length;
    await expect(driver().observe!(driverCtx(session(p), { workspaceId: "ws_other" }), DB)).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(neon.requests).toHaveLength(before);
  });
});

/* -------------------------------- object store ------------------------------ */

describe("zenith.object_store@1", () => {
  const driver = () => byType(createZenithDrivers({ toolkit, kubernetesDrivers: [] }).drivers, nativeTypeFor("zenith", "object_store") ?? PROPOSED_OBJECT_STORE_NATIVE_TYPE);
  const OS = mkNode("object_store/files", "object_store", { size: "small" });

  it("is registered, claims nothing it cannot do, and refuses with the reason", async () => {
    const d = driver();
    expect(d.capabilities).toMatchObject({ compile: false, discover: false, operations: [] });
    const o = await obs(d, OS, session(unavailableDatabaseProvider("x")));
    expect(o.presence).toBe("unknown");
    expect(o.error).toContain(OBJECT_STORE_UNSUPPORTED_REASON);
    expect(o.attributes.provisioned).toMatchObject({ state: "unknown", reason: "not_supported" });
    const v = await d.verify!(driverCtx(session(unavailableDatabaseProvider("x"))), OS, o);
    expect(v.status).toBe("failed");
    expect(v.checks[0].detail).toContain("per-tenant");
  });

  it("explains that credentials, not just configuration, are the blocker when storage is configured", async () => {
    const o = await obs(driver(), OS, session(unavailableDatabaseProvider("x")));
    expect(o.error).not.toMatch(/also not configured/);
    expect(o.native).toMatchObject({ supported: false, reservedPrefix: "tenants/ws_7f3a9c/env_b12e04/" });
  });

  it("also says it is unconfigured when it is", async () => {
    const { ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT: _a, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET: _b, ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF: _c, ...none } = FULL_ENV;
    void [_a, _b, _c];
    const o = await obs(driver(), OS, session(unavailableDatabaseProvider("x"), {}, none));
    expect(o.error).toMatch(/ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT/);
    expect(o.native).not.toHaveProperty("reservedPrefix");
  });

  it("never creates or reads anything: it makes no toolkit or provider calls", async () => {
    await obs(driver(), OS, session(neonProvider()));
    expect(toolkit.applyCalls).toHaveLength(0);
    expect(neon.requests).toHaveLength(0);
  });

  it("refuses another tenant's session", async () => {
    await expect(driver().observe!(driverCtx(session(unavailableDatabaseProvider("x")), { workspaceId: "ws_other" }), OS)).rejects.toMatchObject({ code: "tenant_mismatch" });
  });
});

describe("graph coverage", () => {
  it("every node of the typical environment that renders, or is platform-managed, has a registered driver for its native type", () => {
    registerZenithDrivers({ toolkit, kubernetesDrivers: bases() });
    for (const n of TYPICAL_GRAPH) {
      expect(findDriver("zenith", n.nativeType), `${n.address} → ${n.nativeType}`).toBeDefined();
    }
  });
});
