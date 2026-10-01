/**
 * Shared fixtures for the GCP provider tests: a representative environment
 * graph, a CompileContext whose `ref` resolves to the target's primary tofu
 * resource (`addresses[0]`, the convention every GCP driver follows), and a
 * helper that compiles the whole graph with the real drivers.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import { gcpDrivers } from "@/lib/providers/gcp/drivers";
import { nativeTypeFor } from "@/lib/resources/native-types";
import type { PortableKind, ResourceGraph, ResourceNode } from "@/lib/resources/types";

export const REGION = "asia-south1";
export const PROJECT = "acme-prod-123456";
export const DIGEST = "sha256:" + "a".repeat(64);
export const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/web/app@${DIGEST}`;

export const TAGS = { "zenith:workspace": "ws_1", "zenith:environment": "env_1", "zenith:managed": "true" };

export function mk(address: string, kind: PortableKind, spec: Record<string, unknown>, dependsOn: string[] = [], over: Partial<ResourceNode> = {}): ResourceNode {
  const nativeType = nativeTypeFor("gcp", kind);
  if (!nativeType) throw new Error(`no gcp native type for ${kind}`);
  return {
    address,
    kind,
    provider: "gcp",
    region: REGION,
    nativeType,
    ownership: "managed",
    spec,
    origin: [],
    dependsOn,
    specDigest: "0".repeat(64),
    labels: {},
    ...over,
  };
}

export const SECRET_REF = "vault:ws_1/env_1/api-key";

export function environmentNodes(): ResourceNode[] {
  return [
    mk("network/main", "network", { cidr: "10.20.0.0/16", zones: 2, egress: { natGateways: "single" } }),
    mk("subnet/private-a", "subnet", { tier: "private", zone: "a", cidr: "10.20.1.0/24", network: "network/main" }, ["network/main"]),
    mk("subnet/public-a", "subnet", { tier: "public", zone: "a", cidr: "10.20.101.0/24", network: "network/main" }, ["network/main"]),
    mk("resource/registry", "container_registry", { scanOnPush: true, immutableTags: false }),
    mk(
      "resource/pipeline",
      "build_pipeline",
      { source: { repo: "https://example.com/acme/app.git", ref: "main", dockerfile: "Dockerfile" }, output: { registry: "resource/registry" }, location: "customer_account" },
      ["resource/registry"]
    ),
    mk("secret/api-key", "secret", { secretRef: SECRET_REF, store: "zenith_vault", purpose: "environment" }),
    mk(
      "resource/db",
      "postgres",
      { size: "small", engine: "postgres", version: "16", highAvailability: true, backup: "daily", credentials: "generated", subnetTier: "private", zones: 2, deletionPolicy: "deny", encryption: true },
      ["network/main"]
    ),
    mk(
      "resource/cache",
      "redis",
      { size: "small", engine: "redis", highAvailability: false, backup: "daily", subnetTier: "private", zones: 1, deletionPolicy: "approval", encryption: true },
      ["network/main"]
    ),
    mk("resource/uploads", "object_store", { size: "small", versioning: true, publicAccess: false, deletionPolicy: "approval", encryption: true }),
    mk("resource/jobs", "queue", { size: "small", deletionPolicy: "deny", encryption: true }),
    mk("resource/events", "pubsub", {}),
    mk("log_group/web", "log_group", { workload: "service/web", retentionDays: 30 }),
    mk(
      "identity/web",
      "identity",
      {
        principal: "workload",
        workload: "service/web",
        grants: [
          { target: "resource/db", access: ["connect"], via: ["binding:postgres"] },
          { target: "secret/api-key", access: ["read"], via: ["env:API_KEY"] },
          { target: "resource/uploads", access: ["read", "write"], via: ["binding:object_store"] },
          { target: "resource/jobs", access: ["publish", "consume"], via: ["binding:queue"] },
          { target: "resource/cache", access: ["connect"], via: ["binding:redis"] },
          { target: "resource/registry", access: ["pull"], via: ["image_pull"] },
          { target: "log_group/web", access: ["write"], via: ["own_log_group"] },
        ],
      },
      ["resource/db", "secret/api-key", "resource/uploads", "resource/jobs", "resource/cache", "resource/registry", "log_group/web"]
    ),
    mk(
      "service/web",
      "container_service",
      {
        size: "small",
        vcpu: 1,
        memoryMb: 512,
        artifact: { type: "image", ref: IMAGE },
        env: [
          { key: "NODE_ENV", value: "production" },
          { key: "API_KEY", secretRef: SECRET_REF },
          { key: "GREETING", value: "hello ${not_a_template} %{if}" },
        ],
        zones: 2,
        subnetTier: "private",
        workload: "web",
        replicas: 2,
        port: 3000,
        healthPath: "/healthz",
      },
      ["network/main", "subnet/private-a", "identity/web", "secret/api-key", "resource/db"]
    ),
    mk(
      "service/worker",
      "container_service",
      { size: "small", vcpu: 0.5, memoryMb: 256, artifact: { type: "image", ref: IMAGE }, env: [], zones: 1, subnetTier: "private", workload: "worker", replicas: 1, port: 8080 },
      ["network/main", "subnet/private-a"]
    ),
    mk(
      "job/nightly",
      "scheduled_job",
      { size: "small", vcpu: 1, memoryMb: 512, artifact: { type: "image", ref: IMAGE }, env: [{ key: "MODE", value: "nightly" }], zones: 1, subnetTier: "private", schedule: "0 3 * * *" },
      ["network/main", "subnet/private-a"]
    ),
    mk("firewall/web-to-db", "firewall", { direction: "ingress", protocol: "tcp", port: 5432, source: { address: "service/web" }, target: "resource/db", capability: "postgres", description: "web reaches the database" }, ["network/main", "service/web", "resource/db"]),
    mk("firewall/web-to-cache", "firewall", { direction: "ingress", protocol: "tcp", port: 6378, source: { address: "service/web" }, target: "resource/cache", capability: "redis", description: "web reaches the cache" }, ["network/main", "service/web", "resource/cache"]),
    mk("firewall/public", "firewall", { direction: "ingress", protocol: "tcp", port: 443, source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "public_http", description: "internet to the load balancer" }, ["load_balancer/public"]),
    mk("dns_zone/example.com", "dns_zone", { name: "example.com", private: false }),
    mk("tls_certificate/app.example.com", "tls_certificate", { domain: "app.example.com", validation: "dns_automatic", zone: "dns_zone/example.com" }, ["dns_zone/example.com"]),
    mk(
      "load_balancer/public",
      "load_balancer",
      {
        scheme: "internet-facing",
        tier: "public",
        listeners: [
          { port: 443, protocol: "https" },
          { port: 80, protocol: "http", redirectToHttps: true },
        ],
        routes: [
          { host: "app.example.com", pathPrefix: "/", tls: true, target: "service/web" },
          { host: "app.example.com", pathPrefix: "/worker", tls: true, target: "service/worker" },
        ],
      },
      ["service/web", "service/worker", "tls_certificate/app.example.com"]
    ),
    mk("dns_record/app.example.com", "dns_record", { name: "app.example.com", type: "alias", target: "load_balancer/public", zone: "dns_zone/example.com" }, ["load_balancer/public", "dns_zone/example.com"]),
  ];
}

export function graphOf(nodes: ResourceNode[]): ResourceGraph {
  return { version: 1, environmentId: "env_1", manifestDigest: "m".repeat(8), nodes, edges: [], graphDigest: "g".repeat(8), notes: [] };
}

export const driverFor = (node: ResourceNode): ResourceDriver<GcpSession> => {
  const d = gcpDrivers.find((x) => x.nativeType === node.nativeType);
  if (!d) throw new Error(`no gcp driver for ${node.nativeType}`);
  return d;
};

/**
 * A CompileContext over `nodes`. `ref(address, attr)` returns
 * `${<primary tofu address of that node>.<attr>}` where the primary address is
 * `addresses[0]` of the target's own fragment.
 */
export function compileContext(nodes: ResourceNode[], over: Partial<CompileContext> = {}): { ctx: CompileContext; compileAll(): Map<string, TofuFragment> } {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const cache = new Map<string, TofuFragment>();
  const compileOne = (n: ResourceNode): TofuFragment => {
    const hit = cache.get(n.address);
    if (hit) return hit;
    const f = driverFor(n).compile!(n, ctx);
    cache.set(n.address, f);
    return f;
  };
  const ctx: CompileContext = {
    environmentId: "env_1",
    namePrefix: "zn-env1",
    region: REGION,
    tags: { ...TAGS },
    ref(address, attribute) {
      const target = byAddress.get(address);
      if (!target) throw new Error(`test ref: unknown node ${address}`);
      const primary = compileOne(target).addresses[0];
      if (!primary) throw new Error(`test ref: ${address} has no primary resource`);
      return `\${${primary}.${attribute}}`;
    },
    node: (a) => byAddress.get(a),
    ...over,
  };
  return {
    ctx,
    compileAll() {
      const out = new Map<string, TofuFragment>();
      for (const n of nodes) out.set(n.address, compileOne(n));
      return out;
    },
  };
}
