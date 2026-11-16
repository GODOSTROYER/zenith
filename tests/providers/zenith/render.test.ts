import { describe, expect, it } from "vitest";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";
import { ZENITH_EXTRA_KINDS } from "@/lib/providers/zenith/k8s-port";
import { PLAN_LIMITS } from "@/lib/providers/zenith/plans";
import { assessZenithGraph, hostMappingsOf, renderZenithEnvironment, zenithNodeView } from "@/lib/providers/zenith/render";
import { routeObjectName } from "@/lib/providers/zenith/routing";
import { environmentGatewayParent } from "@/lib/providers/zenith/tls";
import { TENANCY_OBJECTS, ZenithError } from "@/lib/providers/zenith/types";
import {
  DB,
  FULL_ENV,
  FW_WEB_TO_WORKER,
  FakeToolkit,
  LB,
  NS,
  SECRET,
  TENANT,
  TYPICAL_GRAPH,
  WEB,
  WORKER,
  mkNode,
  substrate,
} from "./support";

const sub = substrate();
const render = (nodes = TYPICAL_GRAPH, toolkit = new FakeToolkit(), over: Partial<Parameters<typeof renderZenithEnvironment>[0]> = {}) =>
  renderZenithEnvironment({ tenant: TENANT, substrate: sub, nodes, toolkit, ...over });
const kinds = (objs: K8sObject[]) => objs.map((o) => o.kind);

describe("assessZenithGraph", () => {
  it("classifies a typical environment", () => {
    const a = assessZenithGraph(TYPICAL_GRAPH);
    expect(a.render.map((n) => n.address)).toEqual(["container_service/web", "container_service/worker", "firewall/web-to-worker", "load_balancer/public", "secret/database-url-1a2b3c"]);
    expect(a.databases.map((n) => n.address)).toEqual(["postgres/db"]);
    expect(a.platformManaged.map((n) => n.address)).toEqual(["dns_record/app.customer.com", "firewall/internet-to-lb", "firewall/lb-to-web", "firewall/web-to-db", "network/main", "tls_certificate/app.customer.com"]);
    expect(a.unsupported).toEqual([]);
  });

  it("marks kinds the platform cannot honor as unsupported, with a reason", () => {
    const a = assessZenithGraph([mkNode("redis/cache", "redis", {}), mkNode("object_store/files", "object_store", {}), mkNode("queue/jobs", "queue", {}), mkNode("mysql/m", "mysql", {})]);
    expect(a.unsupported.map((u) => u.kind).sort()).toEqual(["mysql", "object_store", "queue", "redis"]);
    for (const u of a.unsupported) expect(u.reason.length).toBeGreaterThan(10);
  });

  it("does not block on kinds that merely have no managed equivalent", () => {
    const a = assessZenithGraph([mkNode("log_group/web", "log_group", {}), mkNode("build_pipeline/web", "build_pipeline", {})]);
    expect(a.unsupported).toEqual([]);
    expect(a.notOffered.map((n) => n.kind).sort()).toEqual(["build_pipeline", "log_group"]);
  });

  it("treats nodes on another provider or not managed by Zenith as skipped, never rendered", () => {
    const aws = mkNode("container_service/api", "container_service", WEB.spec, { provider: "aws", nativeType: "aws:ecs_service" });
    const ref = mkNode("container_service/ext", "container_service", WEB.spec, { ownership: "referenced" });
    const a = assessZenithGraph([aws, ref, WEB]);
    expect(a.skipped.map((n) => n.address).sort()).toEqual(["container_service/api", "container_service/ext"]);
    expect(a.render.map((n) => n.address)).toEqual(["container_service/web"]);
  });

  it("treats a node whose native type is unsupported as blocking", () => {
    const n = mkNode("container_service/web", "container_service", WEB.spec, { nativeType: "unsupported:zenith:container_service" });
    expect(n.nativeType).toBe("unsupported:zenith:container_service");
    expect(assessZenithGraph([n]).unsupported).toHaveLength(1);
  });

  it("keeps object storage unsupported despite its explicit managed native type", () => {
    const n = mkNode("object_store/files", "object_store", {});
    expect(n.nativeType).toBe("zenith:object_store");
    expect(assessZenithGraph([n]).unsupported).toHaveLength(1);
  });

  it("is deterministic regardless of input order", () => {
    expect(assessZenithGraph([...TYPICAL_GRAPH].reverse())).toEqual(assessZenithGraph(TYPICAL_GRAPH));
  });

  it("treats a firewall whose target is not in the environment as platform-managed rather than failing the render", () => {
    const orphan = mkNode("firewall/orphan", "firewall", { ...FW_WEB_TO_WORKER.spec, target: "container_service/ghost" });
    expect(assessZenithGraph([WEB, orphan]).platformManaged.map((n) => n.address)).toEqual(["firewall/orphan"]);
  });
});

describe("renderZenithEnvironment: the pipeline", () => {
  const r = render();

  it("renders the tenancy baseline separately and first", () => {
    expect(kinds(r.baseline)).toEqual(["Namespace", "ServiceAccount", "ResourceQuota", "LimitRange", "NetworkPolicy", "NetworkPolicy"]);
    expect(r.namespace).toBe(NS);
    expect(r.baseline.every((o) => o.kind === "Namespace" || o.metadata.namespace === NS)).toBe(true);
  });

  it("renders workloads, services, secrets, firewalls and routes into the tenant namespace only", () => {
    expect(kinds(r.workloads).sort()).toEqual(["Deployment", "Deployment", "HTTPRoute", "NetworkPolicy", "Secret", "Service"]);
    for (const o of r.workloads) expect(o.metadata.namespace, `${o.kind}/${o.metadata.name}`).toBe(NS);
  });

  it("NEVER renders a StatefulSet for postgres: the database is a managed intent", () => {
    expect(kinds([...r.baseline, ...r.workloads])).not.toContain("StatefulSet");
    expect(r.databases).toHaveLength(1);
    expect(r.databases[0]).toMatchObject({ address: "postgres/db", connectionSecretRef: "vault:generated/env_b12e04/postgres/db/connection-uri" });
    expect(r.databases[0].spec).toMatchObject({ engineVersion: 16, size: "small", deletionPolicy: "deny", workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId });
  });

  it("preserves the full graph for lookup without rendering platform-managed nodes or databases", () => {
    const toolkit = new FakeToolkit();
    render(TYPICAL_GRAPH, toolkit);
    const graph = toolkit.renderCalls[0].nodes;
    expect(graph.map((n) => n.address).sort()).toEqual(TYPICAL_GRAPH.map((n) => n.address).sort());
    const seen = graph.filter((n) => n.ownership === "managed").map((n) => n.address);
    expect(seen).not.toContain("postgres/db");
    expect(seen).not.toContain("network/main");
    expect(seen).not.toContain("dns_record/app.customer.com");
    expect(seen).not.toContain("tls_certificate/app.customer.com");
    expect(seen).not.toContain("firewall/internet-to-lb");
  });

  it("forces the tenant namespace on every node it hands over, and tells the renderer", () => {
    const toolkit = new FakeToolkit();
    const input = structuredClone(TYPICAL_GRAPH);
    render(input, toolkit);
    const call = toolkit.renderCalls[0];
    expect(call.base.namespace).toBe(NS);
    expect(call.base.environmentId).toBe(TENANT.environmentId);
    expect(call.base.ingressControllerNamespace).toBe(sub.gateway.namespace);
    expect(call.base.automountServiceAccountToken).toBe(false);
    for (const n of call.nodes.filter((n) => n.ownership === "managed")) expect((n.spec as { namespace: string }).namespace, n.address).toBe(NS);
    // the caller's nodes are not mutated
    expect(input).toEqual(TYPICAL_GRAPH);
  });

  it("a node that asks for another namespace is moved into the tenant's", () => {
    const sneaky = mkNode("container_service/web", "container_service", { ...WEB.spec, namespace: "kube-system" });
    const toolkit = new FakeToolkit();
    const out = render([sneaky], toolkit);
    expect(toolkit.renderCalls[0].nodes[0].spec).toMatchObject({ namespace: NS });
    expect(out.workloads.every((o) => o.metadata.namespace === NS)).toBe(true);
  });

  it("runs every tenant pod as the tenant service account", () => {
    const deps = r.workloads.filter((o) => o.kind === "Deployment");
    for (const d of deps) {
      const pod = (d.spec as { template: { spec: { serviceAccountName: string; automountServiceAccountToken: boolean } } }).template.spec;
      expect(pod.serviceAccountName).toBe(TENANCY_OBJECTS.serviceAccount);
      expect(pod.automountServiceAccountToken).toBe(false);
    }
  });

  it("reports what the platform manages and what it left out", () => {
    expect(r.platformManaged.map((p) => p.kind).sort()).toEqual(["dns_record", "firewall", "firewall", "firewall", "network", "tls_certificate"]);
    expect(r.notes.join("\n")).toMatch(/dns_record\/app\.customer\.com: platform-managed/);
  });

  it("is deterministic: same input, byte-identical output, whatever the node order", () => {
    const a = JSON.stringify(render());
    expect(JSON.stringify(render())).toBe(a);
    expect(JSON.stringify(render([...TYPICAL_GRAPH].reverse()))).toBe(a);
  });

  it("is pure over its input", () => {
    const frozen = structuredClone(TYPICAL_GRAPH);
    render(frozen);
    expect(frozen).toEqual(TYPICAL_GRAPH);
  });

  it("renders only the baseline for an environment with nothing to run", () => {
    const toolkit = new FakeToolkit();
    const out = render([DB], toolkit);
    expect(toolkit.renderCalls).toHaveLength(0);
    expect(out.workloads).toEqual([]);
    expect(out.databases).toHaveLength(1);
  });

  it("gives a database-bearing environment its database egress rule, and others none", () => {
    const rule = (out: ReturnType<typeof render>) => JSON.stringify(out.baseline.find((o) => o.metadata.name === TENANCY_OBJECTS.allowPlatform)!.spec);
    expect(rule(render())).toContain("5432");
    expect(rule(render([WEB]))).not.toContain("5432");
  });
});

describe("renderZenithEnvironment: hostnames and routes", () => {
  const r = render();
  const route = r.workloads.find((o) => o.kind === "HTTPRoute")!;

  it("rewrites a custom domain to the managed hostname and reports the mapping", () => {
    expect(r.hostnames).toEqual([{ source: "app.customer.com", managed: "web.production.acme.apps.example.com", target: "container_service/web" }]);
    expect(r.notes.join("\n")).toMatch(/app\.customer\.com is not served on the managed platform.*web\.production\.acme\.apps\.example\.com/);
  });

  it("renders an HTTPRoute (never an Ingress) attached to the platform Gateway, for the managed host only", () => {
    expect(kinds(r.workloads)).not.toContain("Ingress");
    expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(route.metadata.name).toBe(routeObjectName("web.production.acme.apps.example.com"));
    expect(route.spec).toMatchObject({
      parentRefs: [environmentGatewayParent(TENANT, sub)],
      hostnames: ["web.production.acme.apps.example.com"],
      rules: [{ matches: [{ path: { type: "PathPrefix", value: "/" } }], backendRefs: [{ name: "web", port: 8080 }] }],
    });
  });

  it("records the source host on the route and carries the ownership marks", () => {
    expect(route.metadata.annotations?.["zenith.dev/source-hosts"]).toBe("app.customer.com");
    expect(route.metadata.annotations?.["zenith.dev/environment"]).toBe(TENANT.environmentId);
    expect(route.metadata.annotations?.["zenith.dev/resource"]).toBe("load_balancer/public");
    expect(route.metadata.labels?.["app.kubernetes.io/managed-by"]).toBe("zenith");
    expect(route.metadata.labels?.["zenith.dev/route"]).toBe("true");
  });

  it("never lets the Kubernetes renderer see a custom host", () => {
    const toolkit = new FakeToolkit();
    render(TYPICAL_GRAPH, toolkit);
    const lb = toolkit.renderCalls[0].nodes.find((n) => n.kind === "load_balancer")!;
    expect(JSON.stringify(lb.spec)).not.toContain("customer.com");
  });

  it("keeps a host the tenant already chose under its own managed suffix", () => {
    const lb = mkNode("load_balancer/public", "load_balancer", { ...LB.spec, routes: [{ host: "api.production.acme.apps.example.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }] });
    const out = render([WEB, lb]);
    expect(out.hostnames[0]).toMatchObject({ source: "api.production.acme.apps.example.com", managed: "api.production.acme.apps.example.com" });
    expect(out.notes.join("\n")).not.toMatch(/is not served on the managed platform/);
  });

  it("does not trust a host that merely looks like another tenant's managed name", () => {
    const lb = mkNode("load_balancer/public", "load_balancer", { ...LB.spec, routes: [{ host: "web.production.victim.apps.example.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }] });
    const out = render([WEB, lb]);
    expect(out.hostnames[0].managed).toBe("web.production.acme.apps.example.com");
    const hostnames = out.workloads.filter((o) => o.kind === "HTTPRoute").flatMap((o) => (o.spec as { hostnames: string[] }).hostnames);
    expect(hostnames).toEqual(["web.production.acme.apps.example.com"]);
  });

  it("merges routes to different services into one route per managed host, preserving paths", () => {
    const lb = mkNode("load_balancer/public", "load_balancer", {
      ...LB.spec,
      routes: [
        { host: "app.customer.com", pathPrefix: "/api", tls: true, target: "container_service/worker", port: 9000 },
        { host: "app.customer.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 },
        { host: "www.customer.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 },
      ],
    });
    const out = render([WEB, WORKER, lb]);
    const routes = out.workloads.filter((o) => o.kind === "HTTPRoute");
    expect(routes.map((x) => (x.spec as { hostnames: string[] }).hostnames[0]).sort()).toEqual(["web.production.acme.apps.example.com", "worker.production.acme.apps.example.com"]);
    const webRoute = routes.find((x) => (x.spec as { hostnames: string[] }).hostnames[0].startsWith("web."))!;
    expect(webRoute.metadata.annotations?.["zenith.dev/source-hosts"]).toBe("app.customer.com,www.customer.com");
    const workerRoute = routes.find((x) => (x.spec as { hostnames: string[] }).hostnames[0].startsWith("worker."))!;
    expect((workerRoute.spec as { rules: { matches: { path: { value: string } }[] }[] }).rules[0].matches[0].path.value).toBe("/api");
  });

  it("refuses a service whose name cannot form a valid hostname label, rather than sanitizing it", () => {
    const odd = mkNode("container_service/Web_App", "container_service", WEB.spec);
    const lb = mkNode("load_balancer/public", "load_balancer", { ...LB.spec, routes: [{ host: "x.customer.com", pathPrefix: "/", tls: true, target: "container_service/Web_App", port: 8080 }] });
    expect(() => render([odd, lb])).toThrow(/not a valid DNS label/);
  });

  it("a slug that is not a DNS label fails before anything renders", () => {
    expect(() => render(TYPICAL_GRAPH, new FakeToolkit(), { tenant: { ...TENANT, workspaceSlug: "Acme Corp" } })).toThrow(ZenithError);
  });

  it("host mappings are available without rendering", () => {
    expect(hostMappingsOf(TYPICAL_GRAPH, TENANT, sub)).toEqual(r.hostnames);
  });

  it("serves through an Ingress, with TLS left to the controller, when the substrate says ingress", () => {
    const ingressSub = substrate({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx-public" });
    const out = renderZenithEnvironment({ tenant: TENANT, substrate: ingressSub, nodes: TYPICAL_GRAPH, toolkit: new FakeToolkit() });
    expect(kinds(out.workloads)).toContain("Ingress");
    expect(kinds(out.workloads)).not.toContain("HTTPRoute");
    const ing = out.workloads.find((o) => o.kind === "Ingress")!;
    expect((ing.spec as { ingressClassName: string; tls?: unknown }).ingressClassName).toBe("nginx-public");
    expect((ing.spec as { tls?: unknown }).tls).toBeUndefined();
    expect(ing.metadata.annotations?.["zenith.dev/source-hosts"]).toBe("app.customer.com");
    expect(JSON.stringify(ing.spec)).toContain("web.production.acme.apps.example.com");
  });
});

describe("renderZenithEnvironment: refusals", () => {
  it("refuses unsupported kinds with a named list, never dropping them silently", () => {
    const redis = mkNode("redis/cache", "redis", {});
    expect(() => render([WEB, redis])).toThrow(ZenithError);
    try {
      render([WEB, redis]);
    } catch (e) {
      expect((e as ZenithError).code).toBe("unsupported");
      expect((e as ZenithError).message).toContain("redis/cache");
    }
  });

  it("enforces the plan's managed database count", () => {
    const db2 = mkNode("postgres/db2", "postgres", DB.spec);
    expect(() => render([DB, db2], new FakeToolkit(), { tenant: { ...TENANT, planTier: "free" } })).toThrow(/free plan allows 1 managed database/);
    expect(PLAN_LIMITS.starter.maxManagedDatabases).toBeGreaterThanOrEqual(2);
    expect(render([DB, db2]).databases).toHaveLength(2);
  });

  it("refuses an unreadable postgres spec with the node's address", () => {
    const bad = mkNode("postgres/db", "postgres", { ...DB.spec, version: "latest" });
    expect(() => render([bad])).toThrow(/postgres\/db.*version/);
    const badSize = mkNode("postgres/db", "postgres", { ...DB.spec, size: "gigantic" });
    expect(() => render([badSize])).toThrow(/gigantic/);
  });

  it("notes unmet high availability and backup requests instead of pretending", () => {
    const ha = mkNode("postgres/db", "postgres", { ...DB.spec, highAvailability: true, backup: "hourly" });
    const out = render([ha]);
    expect(out.notes.join("\n")).toMatch(/highAvailability was requested/);
    expect(out.notes.join("\n")).toMatch(/backup "hourly" was requested/);
  });

  it("rejects a toolkit that returns a StatefulSet anyway", () => {
    const toolkit = new FakeToolkit();
    const web = mkNode("container_service/web", "container_service", WEB.spec);
    const original = toolkit.renderGraph.bind(toolkit);
    toolkit.renderGraph = (nodes, base) => {
      const out = original(nodes, base);
      const dep = out.objects.find((o) => o.kind === "Deployment")!;
      return { ...out, objects: [...out.objects, { ...dep, kind: "StatefulSet", metadata: { ...dep.metadata, name: "sneaky-db" } }] };
    };
    expect(() => render([web], toolkit)).toThrow(/StatefulSet is never rendered/);
  });

  it.each([
    ["hostPath", { hostPath: true }, "volume_type"],
    ["privileged", { privileged: true }, "privileged"],
    ["hostNetwork", { hostNetwork: true }, "host_namespace"],
    ["LoadBalancer service", { serviceTypeLoadBalancer: true }, "service_type"],
    ["capability added", { addCapability: true }, "capabilities"],
    ["root user", { runAsRoot: true }, "run_as_root"],
    ["missing seccomp", { noSeccomp: true }, "seccomp"],
    ["another namespace", { otherNamespace: "kube-system" }, "namespace_scope"],
  ] as const)("the isolation gate stops a renderer that emits %s", (_name, hostile, rule) => {
    const toolkit = new FakeToolkit();
    toolkit.hostile = hostile;
    expect(() => render([WEB], toolkit)).toThrow(ZenithError);
    try {
      render([WEB], toolkit);
    } catch (e) {
      expect((e as ZenithError).code).toBe("isolation_violation");
      expect((e as ZenithError).message).toContain(rule);
    }
  });
});

describe("renderZenithEnvironment: built images", () => {
  const built = mkNode("container_service/web", "container_service", { ...WEB.spec, artifact: { type: "built", pipeline: "build_pipeline/web" } });
  const digestRef = `registry.example.com/zenith/acme/web@sha256:${"a".repeat(64)}`;

  it("runs a built image from the platform registry, pinned by digest", () => {
    const out = render([built], new FakeToolkit(), { builtImages: { "build_pipeline/web": digestRef } });
    expect(JSON.stringify(out.workloads)).toContain(digestRef);
  });

  it("refuses an image from any other registry, a tag instead of a digest, and a missing registry", () => {
    expect(() => render([built], new FakeToolkit(), { builtImages: { "build_pipeline/web": `docker.io/evil/web@sha256:${"a".repeat(64)}` } })).toThrow(/not in the platform registry/);
    expect(() => render([built], new FakeToolkit(), { builtImages: { "build_pipeline/web": "registry.example.com/zenith/acme/web:latest" } })).toThrow(/pinned by digest/);
    const noRegistry = substrate({ ...FULL_ENV, ZENITH_MANAGED_REGISTRY: "" });
    expect(() => renderZenithEnvironment({ tenant: TENANT, substrate: noRegistry, nodes: [built], toolkit: new FakeToolkit(), builtImages: { "build_pipeline/web": digestRef } })).toThrow(/no platform registry/);
  });

  it("refuses to render a built artifact that has no image yet, from the renderer's own error", () => {
    expect(() => render([built])).toThrow(/no image reference/);
  });
});

describe("static_site and secrets on the managed platform", () => {
  it("serves a static site through the Kubernetes path (Deployment + Service + HTTPRoute), not the hosted-apps subsystem", () => {
    const site = mkNode("static_site/marketing", "static_site", { size: "nano", artifact: { type: "image", ref: "ghcr.io/acme/site:3" }, port: 8080 });
    const lb = mkNode("load_balancer/public", "load_balancer", { ...LB.spec, routes: [{ host: "www.customer.com", pathPrefix: "/", tls: true, target: "static_site/marketing", port: 8080 }] });
    const out = render([site, lb]);
    expect(kinds(out.workloads).sort()).toEqual(["Deployment", "HTTPRoute", "Service"]);
    expect(out.hostnames[0].managed).toBe("marketing.production.acme.apps.example.com");
  });

  it("renders Secret objects without data, referencing the vault reference only", () => {
    const out = render([SECRET]);
    const secret = out.workloads.find((o) => o.kind === "Secret")!;
    expect(secret.data).toBeUndefined();
    expect(secret.stringData).toBeUndefined();
    expect(secret.metadata.annotations?.["zenith.dev/secret-ref"]).toBe("vault:generated/env_b12e04/postgres/db/connection-uri");
  });
});

describe("zenithNodeView", () => {
  it("forces the namespace and rewrites load balancer hosts without touching anything else", () => {
    const v = zenithNodeView(LB, TENANT, sub);
    expect(v.spec.namespace).toBe(NS);
    expect(JSON.stringify(v.spec.routes)).toContain("web.production.acme.apps.example.com");
    expect(v.specDigest).toBe(LB.specDigest);
    expect(v.address).toBe(LB.address);
    expect(LB.spec.namespace).toBeUndefined();
    expect(JSON.stringify(LB.spec.routes)).toContain("app.customer.com");
  });

  it("leaves non-load-balancer specs alone apart from the namespace", () => {
    expect(zenithNodeView(WEB, TENANT, sub).spec).toEqual({ ...WEB.spec, namespace: NS });
  });
});

describe("the kinds the tenancy layer needs from the Kubernetes provider", () => {
  it("are exactly the three it renders beyond what Kubernetes' KIND_INFO listed", () => {
    expect(ZENITH_EXTRA_KINDS.map((k) => k.kind).sort()).toEqual(["HTTPRoute", "LimitRange", "ResourceQuota"]);
    const out = render();
    const emitted = new Set([...out.baseline, ...out.workloads].map((o) => o.kind));
    for (const k of ZENITH_EXTRA_KINDS) expect(emitted.has(k.kind), k.kind).toBe(true);
  });

  it("every object it emits is one the (extended) apply layer can take: known kinds only", () => {
    const known = new Set(["Namespace", "ServiceAccount", "Secret", "PersistentVolumeClaim", "Service", "NetworkPolicy", "Deployment", "CronJob", "HorizontalPodAutoscaler", "Ingress", ...ZENITH_EXTRA_KINDS.map((k) => k.kind)]);
    const out = render();
    for (const o of [...out.baseline, ...out.workloads]) expect(known.has(o.kind), o.kind).toBe(true);
  });
});
