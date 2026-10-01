/**
 * Shared test builders: nodes, render contexts, sessions bound to the fake API.
 */
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { digest } from "@/lib/controlplane/digest";
import { createKubernetesSession, type ScopedKubernetesSession } from "@/lib/providers/kubernetes/session";
import type { DriverContext } from "@/lib/drivers/types";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { K8sRenderContext } from "@/lib/providers/kubernetes/types";
import type { FakeK8s } from "./fake-api";

export const ENV_ID = "env-prod-1";
export const OTHER_ENV = "env-staging-9";

export function node(partial: Partial<ResourceNode> & Pick<ResourceNode, "address" | "kind" | "spec">): ResourceNode {
  const nativeTypes: Record<string, string> = {
    network: "k8s:Namespace",
    kubernetes_namespace: "k8s:Namespace",
    firewall: "k8s:NetworkPolicy",
    load_balancer: "k8s:Ingress",
    dns_record: "k8s:DNSEndpoint",
    tls_certificate: "k8s:Certificate",
    container_service: "k8s:Deployment",
    static_site: "k8s:Deployment",
    scheduled_job: "k8s:CronJob",
    postgres: "k8s:StatefulSet",
    mysql: "k8s:StatefulSet",
    redis: "k8s:StatefulSet",
    secret: "k8s:Secret",
    identity: "k8s:ServiceAccount",
    volume: "k8s:PersistentVolumeClaim",
  };
  const base: ResourceNode = {
    provider: "kubernetes",
    region: "local",
    nativeType: nativeTypes[partial.kind] ?? "k8s:Deployment",
    ownership: "managed",
    origin: [],
    dependsOn: [],
    specDigest: "",
    labels: {},
    ...partial,
  };
  return { ...base, specDigest: digest({ kind: base.kind, spec: base.spec }).slice(0, 16) };
}

export const NS = "shop";

export const networkNode = (): ResourceNode => node({ address: "network/main", kind: "network", spec: { zones: 1, namespace: NS } });

export function serviceNode(over: Record<string, unknown> = {}, address = "service/web"): ResourceNode {
  return node({
    address,
    kind: "container_service",
    dependsOn: ["network/main"],
    spec: {
      workload: "web",
      size: "small",
      vcpu: 0.5,
      memoryMb: 512,
      artifact: { type: "image", ref: "ghcr.io/acme/web:1.2.3" },
      env: [
        { key: "LOG_LEVEL", value: "info" },
        { key: "STRIPE_KEY", secretRef: "vault:proj1/svc1/STRIPE_KEY" },
      ],
      zones: 1,
      subnetTier: "private",
      replicas: 2,
      port: 8080,
      healthPath: "/healthz",
      ...over,
    },
  });
}

export function ctxFor(nodes: readonly ResourceNode[], over: Partial<K8sRenderContext> = {}): K8sRenderContext {
  const by = new Map(nodes.map((n) => [n.address, n]));
  return { environmentId: ENV_ID, node: (a) => by.get(a), nodes: () => nodes, ...over };
}

export function config(fake: FakeK8s, namespaces: string[] = [NS]): KubernetesConnectionConfig {
  return { provider: "kubernetes", mode: "kubeconfig_ref", server: fake.url, credentialRef: "vault:test/token", namespaces };
}

export function sessionFor(fake: FakeK8s, namespaces: string[] = [NS], now?: () => Date): Promise<ScopedKubernetesSession> {
  return createKubernetesSession(config(fake, namespaces), { resolveCredential: async () => fake.token, allowInsecureLoopback: true, now });
}

export const SECRET_CANARY = "canary-SECRET-value-do-not-leak-7f3a9c";

export const resolver = (values: Record<string, string> = {}) => async (ref: string): Promise<string | null> =>
  ref in values ? values[ref] : ref.includes("STRIPE_KEY") ? SECRET_CANARY : null;

/* ------------------------------ a whole graph ------------------------------ */

export const dbNode = (over: Record<string, unknown> = {}): ResourceNode =>
  node({
    address: "resource/db",
    kind: "postgres",
    dependsOn: ["network/main"],
    spec: { size: "small", engine: "postgres", version: "16", highAvailability: false, backup: "none", credentials: "generated", subnetTier: "private", zones: 1, deletionPolicy: "deny", encryption: true, ...over },
  });

export const cacheNode = (): ResourceNode =>
  node({
    address: "resource/cache",
    kind: "redis",
    dependsOn: ["network/main"],
    spec: { size: "nano", engine: "redis", highAvailability: false, backup: "none", subnetTier: "private", zones: 1, deletionPolicy: "allow", encryption: true },
  });

export const secretNode = (ref = "vault:proj1/svc1/STRIPE_KEY"): ResourceNode =>
  node({ address: "secret/stripe-key", kind: "secret", dependsOn: ["network/main"], spec: { secretRef: ref, store: "zenith_vault", purpose: "environment" } });

export const identityNode = (): ResourceNode =>
  node({ address: "identity/web", kind: "identity", dependsOn: ["network/main"], spec: { principal: "workload", workload: "service/web", grants: [{ target: "resource/db", access: ["connect"], via: ["binding:postgres"] }] } });

export const firewallToDb = (): ResourceNode =>
  node({
    address: "firewall/web-to-db",
    kind: "firewall",
    dependsOn: ["network/main"],
    spec: { direction: "ingress", protocol: "tcp", port: 5432, source: { address: "service/web" }, target: "resource/db", capability: "postgres", description: "web reaches the database" },
  });

export const lbNode = (): ResourceNode =>
  node({
    address: "load_balancer/public",
    kind: "load_balancer",
    dependsOn: ["network/main", "service/web"],
    spec: {
      scheme: "internet-facing",
      tier: "public",
      listeners: [
        { port: 80, protocol: "http", redirectToHttps: true },
        { port: 443, protocol: "https" },
      ],
      routes: [{ host: "app.example.com", pathPrefix: "/", tls: true, target: "service/web", port: 8080, healthPath: "/healthz" }],
      ingressClass: "nginx",
    },
  });

export const publicFirewall = (): ResourceNode =>
  node({
    address: "firewall/internet-to-lb",
    kind: "firewall",
    dependsOn: ["network/main"],
    spec: { direction: "ingress", protocol: "tcp", port: 443, source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "public_http", description: "internet reaches the load balancer" },
  });

export const certNode = (): ResourceNode =>
  node({ address: "tls_certificate/app.example.com", kind: "tls_certificate", dependsOn: ["network/main"], spec: { domain: "app.example.com", validation: "dns_automatic", zone: "example.com" } });

export const dnsNode = (): ResourceNode =>
  node({ address: "dns_record/app.example.com", kind: "dns_record", dependsOn: ["network/main", "load_balancer/public"], spec: { name: "app.example.com", type: "alias", target: "load_balancer/public", zone: "example.com" } });

export const cronNode = (over: Record<string, unknown> = {}): ResourceNode =>
  node({
    address: "scheduled_job/nightly",
    kind: "scheduled_job",
    dependsOn: ["network/main"],
    spec: { size: "small", vcpu: 0.25, memoryMb: 256, artifact: { type: "image", ref: "ghcr.io/acme/job:7" }, env: [], zones: 1, subnetTier: "private", schedule: "0 3 * * *", ...over },
  });

export const volumeNode = (): ResourceNode =>
  node({ address: "volume/uploads", kind: "volume", dependsOn: ["network/main"], spec: { sizeGb: 10, storageClass: "fast" } });

export const siteNode = (): ResourceNode =>
  node({ address: "static_site/docs", kind: "static_site", dependsOn: ["network/main"], spec: { size: "nano", artifact: { type: "image", ref: "ghcr.io/acme/docs:3" } } });

/** Every kind the provider renders, in one graph. */
export function fullGraph(): ResourceNode[] {
  return [
    networkNode(),
    identityNode(),
    secretNode(),
    serviceNode(),
    cronNode(),
    dbNode(),
    cacheNode(),
    firewallToDb(),
    lbNode(),
    publicFirewall(),
    certNode(),
    dnsNode(),
    volumeNode(),
    siteNode(),
  ];
}

export const fullCtx = (nodes: readonly ResourceNode[] = fullGraph(), over: Partial<K8sRenderContext> = {}): K8sRenderContext =>
  ctxFor(nodes, { resolveDnsTarget: () => "lb.example.elb.amazonaws.com", ...over });

/**
 * Drivers have no graph, so a node must carry its own namespace for reads and
 * operations (expansion has to write `spec.namespace` on every Kubernetes node;
 * see the handoff). This gives a graph-rendered node that shape.
 */
export const inNs = (n: ResourceNode, namespace = NS): ResourceNode => ({ ...n, spec: { ...(n.spec as object), namespace } });

export function driverCtx(session: KubernetesSession, over: Partial<DriverContext<KubernetesSession>> = {}): DriverContext<KubernetesSession> {
  return {
    provider: "kubernetes",
    region: "local",
    workspaceId: "ws-1",
    environmentId: ENV_ID,
    session,
    signal: new AbortController().signal,
    log: () => {},
    tags: {},
    now: () => new Date("2026-09-30T12:00:00Z"),
    ...over,
  };
}

/** A pod of the `web` Deployment, as the API would report it. */
export function pod(name: string, status: Record<string, unknown> = {}, labels: Record<string, string> = {}, created = "2026-09-30T11:00:00Z") {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: NS,
      creationTimestamp: created,
      labels: { "app.kubernetes.io/name": "web", "app.kubernetes.io/part-of": ENV_ID, ...labels },
    },
    status: { phase: "Running", ...status },
  };
}
