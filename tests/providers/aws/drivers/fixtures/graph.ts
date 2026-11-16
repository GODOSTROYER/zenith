/**
 * A hand-built, realistic AWS ResourceGraph for driver tests: what graph
 * expansion produces for "a public web service and an API behind one HTTPS load
 * balancer, both talking to Postgres", in a two-zone production environment.
 *
 *   network/main                 10.0.0.0/16, 2 zones, NAT per zone
 *   subnet/public-{a,b}          10.0.0.0/24, 10.0.1.0/24
 *   subnet/private-{a,b}         10.0.10.0/24, 10.0.11.0/24
 *   load_balancer/public         :80 redirects to :443; app.acme.io → web,
 *                                app.acme.io/api → api, plain.acme.io (tls off) → web
 *   container_service/{web,api}  ports 3000 / 8080
 *   postgres/db
 *   firewall/internet-to-lb-{80,443}, lb-to-{web,api}, {web,api}-to-db
 *   dns_zone/acme.io (referenced), dns_record/{app,plain}.acme.io
 *   tls_certificate/app.acme.io  dns_automatic, in dns_zone/acme.io
 *
 * Addresses, dependsOn and spec shapes follow `expandManifest()` (see
 * src/lib/resources/expand-*.ts on the platform branch); specs are typed from
 * `src/lib/resources/specs.ts`. Other AWS driver workers may copy this file.
 * `fixtureGraph()` returns fresh objects on every call, so a test may mutate its
 * copy.
 */
import type {
  ContainerServiceSpec,
  DnsRecordSpec,
  DnsZoneSpec,
  FirewallSpec,
  LoadBalancerSpec,
  NetworkSpec,
  PostgresSpec,
  SubnetSpec,
  TlsCertificateSpec,
} from "@/lib/resources/specs";
import type { PortableKind, ResourceGraph, ResourceNode } from "@/lib/resources/types";

export const FIXTURE_ENVIRONMENT_ID = "env_prod";
export const FIXTURE_WORKSPACE_ID = "ws_acme";
export const FIXTURE_REGION = "us-east-1";
export const FIXTURE_NAME_PREFIX = "acme-prod";
export const FIXTURE_TAGS: Record<string, string> = {
  "zenith:environment": FIXTURE_ENVIRONMENT_ID,
  "zenith:env-class": "production",
  "zenith:managed": "true",
  "zenith:workspace": FIXTURE_WORKSPACE_ID,
};
export const FIXTURE_NOW = new Date("2026-09-30T12:00:00.000Z");

export const LB = "load_balancer/public";
export const NETWORK = "network/main";
export const ZONE = "dns_zone/acme.io";
export const CERT = "tls_certificate/app.acme.io";

const NATIVE: Record<string, string> = {
  network: "aws:vpc",
  subnet: "aws:subnet",
  firewall: "aws:security_group_rule",
  load_balancer: "aws:alb",
  dns_zone: "aws:route53_zone",
  dns_record: "aws:route53_record",
  tls_certificate: "aws:acm_certificate",
  container_service: "aws:ecs_service",
  postgres: "aws:rds_instance",
};

export function makeNode(address: string, kind: PortableKind, spec: object, dependsOn: string[] = [], over: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind,
    provider: "aws",
    region: FIXTURE_REGION,
    nativeType: NATIVE[kind] ?? `aws:${kind}`,
    ownership: "managed",
    spec: { ...spec } as Record<string, unknown>,
    origin: [],
    dependsOn,
    specDigest: "0".repeat(64),
    labels: {},
    ...over,
  };
}

const workload = (port: number, healthPath: string): ContainerServiceSpec => ({
  size: "standard",
  vcpu: 0.5,
  memoryMb: 1024,
  artifact: { type: "image", ref: "ghcr.io/acme/app:1" },
  env: [{ key: "LOG_LEVEL", value: "info" }],
  zones: 2,
  subnetTier: "private",
  workload: "web",
  replicas: 2,
  port,
  healthPath,
});

const rule = (id: string, source: FirewallSpec["source"], target: string, port: number, capability: string, description: string): ResourceNode =>
  makeNode(
    `firewall/${id}`,
    "firewall",
    { direction: "ingress", protocol: "tcp", port, source, target, capability, description } satisfies FirewallSpec,
    "address" in source ? [source.address, target] : [target]
  );

export function fixtureGraph(): ResourceGraph {
  const publicSubnets = ["subnet/public-a", "subnet/public-b"];
  const privateSubnets = ["subnet/private-a", "subnet/private-b"];
  const subnet = (tier: SubnetSpec["tier"], zone: string, cidr: string): ResourceNode =>
    makeNode(`subnet/${tier}-${zone}`, "subnet", { tier, zone, cidr, network: NETWORK } satisfies SubnetSpec, [NETWORK]);

  const nodes: ResourceNode[] = [
    makeNode(NETWORK, "network", { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "per_az" } } satisfies NetworkSpec),
    subnet("public", "a", "10.0.0.0/24"),
    subnet("public", "b", "10.0.1.0/24"),
    subnet("private", "a", "10.0.10.0/24"),
    subnet("private", "b", "10.0.11.0/24"),

    makeNode(ZONE, "dns_zone", { name: "acme.io", private: false } satisfies DnsZoneSpec, [], { ownership: "referenced" }),
    makeNode(CERT, "tls_certificate", { domain: "app.acme.io", validation: "dns_automatic", zone: ZONE } satisfies TlsCertificateSpec, [ZONE]),

    makeNode(
      LB,
      "load_balancer",
      {
        scheme: "internet-facing",
        tier: "public",
        listeners: [{ port: 80, protocol: "http", redirectToHttps: true }, { port: 443, protocol: "https" }],
        routes: [
          { host: "app.acme.io", pathPrefix: "/", tls: true, target: "container_service/web", port: 3000, healthPath: "/healthz" },
          { host: "app.acme.io", pathPrefix: "/api", tls: true, target: "container_service/api", port: 8080, healthPath: "/health" },
          { host: "plain.acme.io", pathPrefix: "/", tls: false, target: "container_service/web", port: 3000, healthPath: "/healthz" },
        ],
      } satisfies LoadBalancerSpec,
      [...publicSubnets, CERT]
    ),

    makeNode("container_service/web", "container_service", workload(3000, "/healthz"), privateSubnets),
    makeNode("container_service/api", "container_service", workload(8080, "/health"), privateSubnets),
    makeNode(
      "postgres/db",
      "postgres",
      {
        size: "standard",
        deletionPolicy: "deny",
        encryption: true,
        engine: "postgres",
        version: "16",
        highAvailability: true,
        backup: "daily",
        credentials: "generated",
        subnetTier: "private",
        zones: 2,
      } satisfies PostgresSpec,
      privateSubnets
    ),

    rule("internet-to-lb-80", { cidr: "0.0.0.0/0" }, LB, 80, "public_http", "the public internet reaches the load balancer on tcp/80"),
    rule("internet-to-lb-443", { cidr: "0.0.0.0/0" }, LB, 443, "public_http", "the public internet reaches the load balancer on tcp/443"),
    rule("lb-to-web", { address: LB }, "container_service/web", 3000, "http", "the load balancer reaches web on tcp/3000"),
    rule("lb-to-api", { address: LB }, "container_service/api", 8080, "http", "the load balancer reaches api on tcp/8080"),
    rule("web-to-db", { address: "container_service/web" }, "postgres/db", 5432, "sql", "web reaches db (sql) on tcp/5432"),
    rule("api-to-db", { address: "container_service/api" }, "postgres/db", 5432, "sql", "api reaches db (sql) on tcp/5432"),

    makeNode("dns_record/app.acme.io", "dns_record", { name: "app.acme.io", type: "alias", target: LB, zone: ZONE } satisfies DnsRecordSpec, [LB, ZONE]),
    makeNode("dns_record/plain.acme.io", "dns_record", { name: "plain.acme.io", type: "alias", target: LB, zone: ZONE } satisfies DnsRecordSpec, [LB, ZONE]),
  ];
  nodes.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { version: 1, environmentId: FIXTURE_ENVIRONMENT_ID, manifestDigest: "m".repeat(8), nodes, edges: [], graphDigest: "g".repeat(8), notes: [] };
}

/** The node at `address`; throws when the fixture has none (a typo in a test). */
export function nodeOf(graph: ResourceGraph, address: string): ResourceNode {
  const n = graph.nodes.find((x) => x.address === address);
  if (!n) throw new Error(`fixture has no node ${address}`);
  return n;
}
