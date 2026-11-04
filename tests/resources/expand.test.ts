import { describe, expect, it } from "vitest";
import {
  expandManifest,
  graphDigestOf,
  ManifestExpansionError,
  manifestDigest,
  specDigestOf,
  upgradeManifest,
  type ExpandEnv,
  type ManifestV2,
  type ResourceGraph,
  type ResourceNode,
} from "@/lib/resources";
import { blueprints } from "@/lib/blueprints";
import { PROD, STAGING, bind, fullManifest, graphProblems, manifest, res, route, shuffledManifest, svc, v1Fixtures, webDb } from "./_fixtures";

const node = (g: ResourceGraph, address: string): ResourceNode => {
  const n = g.nodes.find((x) => x.address === address);
  if (!n) throw new Error(`no node ${address}; have ${g.nodes.map((x) => x.address).join(", ")}`);
  return n;
};
const has = (g: ResourceGraph, address: string) => g.nodes.some((n) => n.address === address);
const kinds = (g: ResourceGraph, kind: string) => g.nodes.filter((n) => n.kind === kind).map((n) => n.address);
const notes = (g: ResourceGraph, tag: string) => g.notes.filter((n) => n.startsWith(`${tag}:`));
const v2 = (m: ReturnType<typeof webDb>, extra: Partial<ManifestV2> = {}): ManifestV2 => ({ ...upgradeManifest(m, { provider: "aws", region: "us-east-1" }), ...extra });

describe("expandManifest: web + postgres", () => {
  const g = expandManifest(webDb(), PROD);

  it("derives a network with public and private subnets per zone (production: 2)", () => {
    expect(kinds(g, "network")).toEqual(["network/main"]);
    expect(kinds(g, "subnet")).toEqual(["subnet/private-a", "subnet/private-b", "subnet/public-a", "subnet/public-b"]);
    expect(node(g, "network/main").spec).toEqual({ cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "single" } });
    expect(node(g, "subnet/public-a").spec).toEqual({ tier: "public", zone: "a", cidr: "10.0.0.0/24", network: "network/main" });
    expect(node(g, "subnet/private-b").spec).toEqual({ tier: "private", zone: "b", cidr: "10.0.11.0/24", network: "network/main" });
    expect(node(g, "subnet/private-a").dependsOn).toEqual(["network/main"]);
  });

  it("adds a firewall rule on 5432 from the service to the database, and puts the database in private subnets", () => {
    const fw = node(g, "firewall/web-to-postgres");
    expect(fw.kind).toBe("firewall");
    expect(fw.nativeType).toBe("aws:security_group_rule");
    expect(fw.spec).toMatchObject({ direction: "ingress", protocol: "tcp", port: 5432, source: { address: "container_service/web" }, target: "postgres/postgres", capability: "sql" });
    expect(fw.dependsOn).toEqual(["container_service/web", "postgres/postgres"]);
    const db = node(g, "postgres/postgres");
    expect(db.nativeType).toBe("aws:rds_instance");
    expect(db.spec).toMatchObject({ engine: "postgres", subnetTier: "private", credentials: "generated", backup: "daily", deletionPolicy: "approval", highAvailability: false });
    expect(db.dependsOn).toEqual(["subnet/private-a", "subnet/private-b"]);
    expect(g.edges).toContainEqual({ from: "container_service/web", to: "postgres/postgres", relation: "connects_to", detail: "sql:5432" });
  });

  it("derives a load balancer, certificate, DNS record and a REFERENCED zone from the tls route", () => {
    expect(kinds(g, "load_balancer")).toEqual(["load_balancer/public"]);
    expect(node(g, "load_balancer/public").nativeType).toBe("aws:alb");
    expect(node(g, "load_balancer/public").spec).toMatchObject({
      listeners: [{ port: 80, protocol: "http", redirectToHttps: true }, { port: 443, protocol: "https" }],
      routes: [{ host: "app.atlas.zenith.test", pathPrefix: "/", tls: true, target: "container_service/web", port: 3000, healthPath: "/healthz" }],
    });
    expect(node(g, "load_balancer/public").dependsOn).toContain("tls_certificate/app.atlas.zenith.test");
    expect(node(g, "load_balancer/public").dependsOn).toEqual(expect.arrayContaining(["subnet/public-a", "subnet/public-b"]));
    expect(node(g, "tls_certificate/app.atlas.zenith.test").spec).toMatchObject({ domain: "app.atlas.zenith.test", validation: "dns_automatic", zone: "dns_zone/atlas.zenith.test" });
    expect(node(g, "dns_record/app.atlas.zenith.test").spec).toEqual({ name: "app.atlas.zenith.test", type: "alias", target: "load_balancer/public", zone: "dns_zone/atlas.zenith.test" });
    const zone = node(g, "dns_zone/atlas.zenith.test");
    expect(zone.ownership).toBe("referenced");
    expect(zone.labels["zenith:managed"]).toBe("false");
    expect(notes(g, "dns").some((n) => /never creates a customer's zone/.test(n))).toBe(true);
    expect(g.edges).toContainEqual({ from: "load_balancer/public", to: "container_service/web", relation: "routes_to", detail: "app.atlas.zenith.test/" });
    expect(g.edges).toContainEqual({ from: "dns_record/app.atlas.zenith.test", to: "load_balancer/public", relation: "resolves_to" });
    expect(g.edges).toContainEqual({ from: "tls_certificate/app.atlas.zenith.test", to: "load_balancer/public", relation: "secures" });
  });

  it("opens the load balancer to the internet and lets only it reach the service", () => {
    expect(node(g, "firewall/internet-to-lb-443").spec).toMatchObject({ port: 443, source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "public_http" });
    expect(node(g, "firewall/internet-to-lb-80").spec).toMatchObject({ port: 80 });
    expect(node(g, "firewall/lb-to-web").spec).toMatchObject({ port: 3000, source: { address: "load_balancer/public" }, target: "container_service/web" });
  });

  it("gives the service a log group and a least-privilege identity", () => {
    expect(node(g, "log_group/web").spec).toEqual({ workload: "container_service/web", retentionDays: 30 });
    expect(node(g, "identity/web").spec).toEqual({
      principal: "workload",
      workload: "container_service/web",
      grants: [
        { target: "log_group/web", access: ["write"], via: ["own_log_group"] },
        { target: "postgres/postgres", access: ["read_credentials"], via: ["binding:sql"] },
      ],
    });
  });

  it("records provenance and labels on every node", () => {
    expect(node(g, "container_service/web").origin).toEqual(["svc-web"]);
    expect(node(g, "postgres/postgres").origin).toEqual(["res-db"]);
    expect(node(g, "firewall/web-to-postgres").origin).toEqual(["b-sql", "res-db", "svc-web"]);
    for (const n of g.nodes) {
      expect(n.origin.length, n.address).toBeGreaterThan(0);
      expect(n.labels["zenith:environment"]).toBe("env-prod");
      expect(n.labels["zenith:resource"]).toBe(n.address);
    }
  });

  it("explains each derivation in notes, for the plan view", () => {
    expect(notes(g, "firewall")).toContain("firewall: firewall/web-to-postgres derived: web reaches postgres (sql) on tcp/5432.");
    expect(notes(g, "firewall")).toHaveLength(4);
    expect(notes(g, "routing")).toEqual(["routing: load_balancer/public derived from 1 route to container_service/web; listeners 80 and 443 (port 80 redirects to HTTPS)."]);
    expect(notes(g, "dns").some((n) => n === "dns: dns_record/app.atlas.zenith.test derived from the route for app.atlas.zenith.test; it points at load_balancer/public.")).toBe(true);
    expect(notes(g, "tls")).toEqual(["tls: tls_certificate/app.atlas.zenith.test derived because a route for app.atlas.zenith.test has tls on."]);
    expect(notes(g, "logs")).toEqual(["logs: log_group/web derived for container_service/web (30 day retention)."]);
    expect(notes(g, "identity")[0]).toMatch(/^identity: identity\/web holds 2 least-privilege grants \(log_group\/web, postgres\/postgres\)/);
    expect(notes(g, "topology")).toContain("topology: postgres/postgres is placed in the private subnets, unreachable from the internet.");
    expect(notes(expandManifest(fullManifest(), PROD), "build")).toHaveLength(2);
  });

  it("holds the structural invariants and self-consistent digests", () => {
    expect(graphProblems(g)).toEqual([]);
    for (const n of g.nodes) expect(n.specDigest, n.address).toBe(specDigestOf(n));
    expect(g.graphDigest).toBe(graphDigestOf(g.nodes, g.edges));
    expect(g.manifestDigest).toBe(manifestDigest(webDb()));
    expect(g.environmentId).toBe("env-prod");
    expect(g.version).toBe(1);
  });

  it("makes the service wait for its database and its load balancer", () => {
    expect(node(g, "container_service/web").dependsOn).toEqual(expect.arrayContaining(["postgres/postgres", "load_balancer/public", "identity/web", "log_group/web"]));
  });
});

describe("zones and availability", () => {
  const zones = (g: ResourceGraph) => kinds(g, "subnet").filter((a) => a.includes("private")).length;

  const workloadOnly = () => manifest({ services: [svc({ id: "web", name: "web", kind: "web", port: 3000 })] });

  it("defaults without an AWS data-store minimum: production 2 zones, staging 1", () => {
    expect(zones(expandManifest(workloadOnly(), PROD))).toBe(2);
    expect(zones(expandManifest(workloadOnly(), STAGING))).toBe(1);
    expect(notes(expandManifest(workloadOnly(), STAGING), "topology").some((n) => /1 zone \(staging default\)/.test(n))).toBe(true);
  });

  it("availabilityTarget >= 99.9 forces 2 zones in staging, with a note; 99.89 does not", () => {
    const g = expandManifest(v2(webDb(), { constraints: { availabilityTarget: 99.9 } }), STAGING);
    expect(zones(g)).toBe(2);
    expect(notes(g, "topology").some((n) => /2 zones because availabilityTarget is 99\.9/.test(n))).toBe(true);
    expect(zones(expandManifest(v2(workloadOnly(), { constraints: { availabilityTarget: 99.89 } }), STAGING))).toBe(1);
  });

  it("tolerateSingleFailure forces 2 zones, HA on data stores and one NAT per zone", () => {
    const g = expandManifest(v2(webDb(), { constraints: { tolerateSingleFailure: true } }), STAGING);
    expect(zones(g)).toBe(2);
    expect(node(g, "network/main").spec).toMatchObject({ egress: { natGateways: "per_az" } });
    expect(node(g, "postgres/postgres").spec).toMatchObject({ highAvailability: true, zones: 2 });
    expect(notes(g, "availability").some((n) => /postgres\/postgres gets highAvailability because tolerateSingleFailure/.test(n))).toBe(true);
  });

  it("warns when a demanded-available service runs one replica, without changing it", () => {
    const m = manifest({ services: [svc({ id: "s1", name: "web", kind: "web", port: 80, replicas: 1 })] });
    const g = expandManifest(v2(m, { constraints: { availabilityTarget: 99.99 } }), STAGING);
    expect(notes(g, "availability").some((n) => /container_service\/web runs 1 replica/.test(n))).toBe(true);
    expect(node(g, "container_service/web").spec).toMatchObject({ replicas: 1 });
  });

  it("an explicit placement.zones wins, and is raised (with a note) only when availability demands it", () => {
    expect(zones(expandManifest(v2(webDb(), { placement: { provider: "aws", regions: ["us-east-1"], zones: 3 } }), STAGING))).toBe(3);
    const raised = expandManifest(v2(webDb(), { placement: { provider: "aws", regions: ["us-east-1"], zones: 1 }, constraints: { availabilityTarget: 99.95 } }), PROD);
    expect(zones(raised)).toBe(2);
    expect(notes(raised, "topology").some((n) => /placement\.zones=1 raised to 2/.test(n))).toBe(true);
    expect(zones(expandManifest(v2(workloadOnly(), { placement: { provider: "aws", regions: ["us-east-1"], zones: 1 } }), PROD))).toBe(1);
  });

  it("derives no network at all when nothing needs one", () => {
    const g = expandManifest(manifest({ resources: [res({ id: "r1", name: "assets", kind: "object_store" }), res({ id: "r2", name: "jobs", kind: "queue" })] }), PROD);
    expect(kinds(g, "network")).toEqual([]);
    expect(kinds(g, "subnet")).toEqual([]);
    expect(notes(g, "topology")).toEqual(["topology: no network derived; nothing in this manifest runs inside one."]);
    expect(graphProblems(g)).toEqual([]);
  });

  it("carves CIDRs from providerConfig.aws.vpcCidr and honours natGateways", () => {
    const g = expandManifest(v2(webDb(), { providerConfig: { aws: { vpcCidr: "172.16.0.0/16", natGateways: "none" } } }), PROD);
    expect(node(g, "network/main").spec).toEqual({ cidr: "172.16.0.0/16", zones: 2, egress: { natGateways: "none" } });
    expect(node(g, "subnet/public-a").spec).toMatchObject({ cidr: "172.16.0.0/24" });
    expect(node(g, "subnet/private-a").spec).toMatchObject({ cidr: "172.16.10.0/24" });
    const small = expandManifest(v2(webDb(), { providerConfig: { aws: { vpcCidr: "192.168.32.0/20" } } }), PROD);
    expect(node(small, "subnet/public-b").spec).toMatchObject({ cidr: "192.168.32.16/28" });
    expect(node(small, "subnet/private-a").spec).toMatchObject({ cidr: "192.168.32.160/28" });
  });
});

describe("routes", () => {
  it("a route without tls gets no certificate and only a port-80 listener", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "web", kind: "web", port: 3000 })],
      routes: [route({ id: "r", host: "plain.example.com", tls: false })],
      bindings: [bind("b", "r", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "tls_certificate")).toEqual([]);
    expect(node(g, "load_balancer/public").spec).toMatchObject({ listeners: [{ port: 80, protocol: "http" }] });
    expect(kinds(g, "firewall")).toEqual(["firewall/internet-to-lb", "firewall/lb-to-web"]);
    expect(node(g, "dns_zone/example.com").ownership).toBe("referenced");
  });

  it("managedDns=false: no DNS record, manual certificate validation, a note", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "web", kind: "web", port: 3000 })],
      routes: [route({ id: "r", host: "self.example.com", managedDns: false })],
      bindings: [bind("b", "r", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "dns_record")).toEqual([]);
    expect(kinds(g, "dns_zone")).toEqual([]);
    expect(node(g, "tls_certificate/self.example.com").spec).toEqual({ domain: "self.example.com", validation: "dns_manual" });
    expect(notes(g, "dns").length).toBe(2);
  });

  it("several routes to one host and one service share a record, a certificate and a target", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "web", kind: "web", port: 3000 })],
      routes: [route({ id: "r1", host: "app.example.com" }), route({ id: "r2", host: "APP.example.com", pathPrefix: "/api" })],
      bindings: [bind("b1", "r1", "s", "http"), bind("b2", "r2", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "dns_record")).toEqual(["dns_record/app.example.com"]);
    expect(kinds(g, "tls_certificate")).toEqual(["tls_certificate/app.example.com"]);
    expect((node(g, "load_balancer/public").spec.routes as unknown[]).length).toBe(2);
    expect(kinds(g, "firewall").filter((a) => a.includes("lb-to-web"))).toEqual(["firewall/lb-to-web"]);
  });

  it("a static site behind a route needs DNS and a certificate but no load balancer", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "site", kind: "static" })],
      routes: [route({ id: "r", host: "www.example.com" })],
      bindings: [bind("b", "r", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "load_balancer")).toEqual([]);
    expect(kinds(g, "network")).toEqual([]);
    expect(node(g, "dns_record/www.example.com").spec).toMatchObject({ target: "static_site/site" });
    expect(g.edges).toContainEqual({ from: "tls_certificate/www.example.com", to: "static_site/site", relation: "secures" });
    expect(graphProblems(g)).toEqual([]);
  });

  it("infers the apex heuristically, knows common two-label suffixes, and says it is a guess", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "web", kind: "web", port: 80 })],
      routes: [route({ id: "r1", host: "shop.example.co.uk" }), route({ id: "r2", host: "example.com" })],
      bindings: [bind("b1", "r1", "s", "http"), bind("b2", "r2", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "dns_zone")).toEqual(["dns_zone/example.co.uk", "dns_zone/example.com"]);
    expect(notes(g, "dns").filter((n) => /heuristic/.test(n))).toHaveLength(2);
  });

  it("reports routes that lead nowhere Zenith can wire, and derives nothing for them", () => {
    const m = manifest({
      services: [
        svc({ id: "w", name: "worker", kind: "worker" }),
        svc({ id: "ext", name: "legacy", kind: "web", port: 80, ownership: "referenced" }),
      ],
      routes: [route({ id: "r1", host: "a.example.com" }), route({ id: "r2", host: "b.example.com" }), route({ id: "r3", host: "c.example.com" })],
      bindings: [bind("b1", "r1", "w", "http"), bind("b2", "r2", "ext", "http"), bind("b3", "r3", "ghost", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(kinds(g, "load_balancer")).toEqual([]);
    expect(kinds(g, "dns_record")).toEqual([]);
    expect(notes(g, "route").length).toBe(3);
    expect(notes(g, "route").join("\n")).toMatch(/does not serve HTTP/);
    expect(notes(g, "route").join("\n")).toMatch(/does not wire ingress into services it does not run/);
    expect(notes(g, "route").join("\n")).toMatch(/not a service in this manifest/);
    const unbound = expandManifest(manifest({ routes: [route({ id: "r", host: "x.example.com" })] }), PROD);
    expect(notes(unbound, "route")).toEqual(["route: x.example.com is not bound to a service; no DNS, certificate or load balancer rule derived."]);
  });
});

describe("ownership", () => {
  const g = expandManifest(fullManifest(), PROD);

  it("keeps referenced and external nodes referenced/external, with externalRef, and derives nothing for them", () => {
    const old = node(g, "postgres/old-db");
    expect(old.ownership).toBe("referenced");
    expect(old.externalRef).toBe("legacy.abc.us-east-1.rds.amazonaws.com");
    expect(old.dependsOn).toEqual([]);
    expect(old.spec).toEqual({ size: "small", engine: "postgres" });
    expect(old.labels["zenith:managed"]).toBe("false");
    expect(node(g, "queue/stripe").ownership).toBe("external");
    expect(node(g, "container_service/legacy").ownership).toBe("referenced");
    expect(has(g, "log_group/legacy")).toBe(false);
    expect(has(g, "identity/legacy")).toBe(false);
    for (const n of g.nodes) if (n.ownership !== "managed") expect(n.dependsOn, n.address).toEqual([]);
  });

  it("never adds a firewall rule into a node Zenith does not own, and says what the owner must do", () => {
    expect(kinds(g, "firewall").some((a) => a.includes("old-db"))).toBe(false);
    expect(notes(g, "binding").some((n) => /old-db is referenced, so Zenith adds no firewall rule to it.*port 5432/.test(n))).toBe(true);
    expect(g.edges).toContainEqual({ from: "container_service/api", to: "postgres/old-db", relation: "connects_to", detail: "sql:5432" });
  });

  it("only managed nodes are ever managed", () => {
    const managedFromManifest = new Set(["api", "worker", "nightly", "site"]);
    for (const n of g.nodes.filter((x) => x.kind === "container_service" || x.kind === "scheduled_job" || x.kind === "static_site"))
      expect(n.ownership === "managed", n.address).toBe(managedFromManifest.has(n.address.split("/")[1]));
  });
});

describe("secrets", () => {
  const PLAIN = "sk_live_super-secret-plain-value";
  const m = manifest({
    services: [
      svc({
        id: "svc-a",
        name: "aa",
        kind: "worker",
        env: [
          { key: "MODE", value: "batch" },
          { key: "API_TOKEN", secretRef: "vault:p/svc-a/API_TOKEN", value: PLAIN },
          { key: "DB_PASSWORD", value: PLAIN },
          { key: "EMPTY_REF", value: "x", secretRef: "" },
          { key: "NOTHING" },
          { key: "ZENITH_CHAOS", value: "on" },
        ],
      }),
      svc({ id: "svc-b", name: "bb", kind: "worker", env: [{ key: "API_TOKEN", secretRef: "vault:p/svc-a/API_TOKEN" }] }),
    ],
  });
  const g = expandManifest(m, PROD);

  it("turns a secretRef into a managed secret node holding only the reference, read by every reader", () => {
    const secrets = kinds(g, "secret");
    expect(secrets).toHaveLength(1);
    const s = node(g, secrets[0]);
    expect(s.address).toMatch(/^secret\/api-token-[0-9a-f]{8}$/);
    expect(s.ownership).toBe("managed");
    expect(s.spec).toEqual({ secretRef: "vault:p/svc-a/API_TOKEN", store: "zenith_vault", purpose: "environment" });
    expect(s.origin).toEqual(["svc-a", "svc-b"]);
    expect(g.edges).toContainEqual({ from: "container_service/aa", to: s.address, relation: "reads_secret", detail: "API_TOKEN" });
    expect(g.edges).toContainEqual({ from: "container_service/bb", to: s.address, relation: "reads_secret", detail: "API_TOKEN" });
    expect(node(g, "identity/aa").spec.grants).toContainEqual({ target: s.address, access: ["read"], via: ["env:API_TOKEN"] });
    expect(node(g, "container_service/aa").dependsOn).toContain(s.address);
  });

  it("never copies an inline value that sits next to a secretRef, and says so", () => {
    const env = node(g, "container_service/aa").spec.env as { key: string; value?: string; secretRef?: string }[];
    const tok = env.find((e) => e.key === "API_TOKEN")!;
    expect(tok).toEqual({ key: "API_TOKEN", secretRef: "vault:p/svc-a/API_TOKEN" });
    expect(notes(g, "secrets").some((n) => /aa\.API_TOKEN has both a value and a secretRef/.test(n))).toBe(true);
  });

  it("keeps an inline value under a credential-looking key as authored, but flags it", () => {
    const env = node(g, "container_service/aa").spec.env as { key: string; value?: string }[];
    expect(env.find((e) => e.key === "DB_PASSWORD")).toEqual({ key: "DB_PASSWORD", value: PLAIN });
    expect(notes(g, "secrets").some((n) => /aa\.DB_PASSWORD looks like a credential.*kept as authored.*not moved/.test(n))).toBe(true);
  });

  it("treats an empty secretRef as absent, skips vars with neither, and drops sandbox-only chaos", () => {
    const env = node(g, "container_service/aa").spec.env as { key: string }[];
    expect(env.map((e) => e.key)).toEqual(["API_TOKEN", "DB_PASSWORD", "EMPTY_REF", "MODE"]);
    expect(notes(g, "env").some((n) => /aa\.NOTHING declares neither/.test(n))).toBe(true);
    expect(notes(g, "env").some((n) => /ZENITH_CHAOS is sandbox-only/.test(n))).toBe(true);
    const sandbox = expandManifest(m, { ...PROD, provider: "sandbox", region: "sim-1" });
    expect((node(sandbox, "container_service/aa").spec.env as { key: string }[]).map((e) => e.key)).toContain("ZENITH_CHAOS");
  });

  it("does not put the value of a secretRef var anywhere in the graph or its notes", () => {
    // Only DB_PASSWORD (no secretRef) legitimately carries PLAIN. Remove it and PLAIN must be gone entirely.
    const clean = manifest({ services: [svc({ id: "s", name: "aa", kind: "worker", env: [{ key: "API_TOKEN", secretRef: "vault:p/s/API_TOKEN", value: PLAIN }] })] });
    const json = JSON.stringify(expandManifest(clean, PROD));
    expect(json).not.toContain(PLAIN);
  });

  it("guard: across every fixture, no node spec, edge or note contains a value that belongs to a secretRef var", () => {
    for (const { name, manifest: fm } of v1Fixtures()) {
      const secretValues = fm.services.flatMap((s) => s.env.filter((e) => e.secretRef && e.value).map((e) => e.value as string));
      if (!secretValues.length) continue;
      const json = JSON.stringify(expandManifest(fm, PROD));
      for (const v of secretValues) expect(json, name).not.toContain(v);
    }
    // and prove the guard has teeth: a manifest that does carry such a pair
    const teeth = manifest({ services: [svc({ id: "s", name: "aa", kind: "worker", env: [{ key: "K", secretRef: "vault:p/s/K", value: "leaky-value-123" }] })] });
    expect(JSON.stringify(expandManifest(teeth, PROD))).not.toContain("leaky-value-123");
  });

  it("treats a non-vault reference as referenced: the provider resolves it, Zenith never creates it", () => {
    const g2 = expandManifest(fullManifest(), PROD);
    const stripe = g2.nodes.find((n) => n.kind === "secret" && n.spec.secretRef === "arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe")!;
    expect(stripe.ownership).toBe("referenced");
    expect(stripe.externalRef).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe");
    expect(stripe.spec.store).toBe("provider_secret_manager");
    expect(notes(g2, "secrets").some((n) => /not Zenith's secret store/.test(n))).toBe(true);
  });
});

describe("identity and bindings", () => {
  const g = expandManifest(fullManifest(), PROD);
  const grants = (svcName: string) => node(g, `identity/${svcName}`).spec.grants as { target: string; access: string[]; via: string[] }[];

  it("blob and queue bindings become exact-target grants, not firewall rules", () => {
    expect(grants("api")).toContainEqual({ target: "object_store/assets", access: ["delete", "list", "read", "write"], via: ["binding:blob"] });
    expect(grants("api")).toContainEqual({ target: "queue/jobs", access: ["publish"], via: ["binding:queue_publish"] });
    expect(grants("worker")).toContainEqual({ target: "queue/jobs", access: ["consume"], via: ["binding:queue_consume"] });
    expect(kinds(g, "firewall").some((a) => /assets|jobs/.test(a))).toBe(false);
  });

  it("never emits a wildcard grant", () => {
    for (const n of g.nodes.filter((x) => x.kind === "identity"))
      for (const gr of n.spec.grants as { target: string; access: string[] }[]) {
        expect(gr.target).not.toMatch(/\*/);
        expect(gr.access.join()).not.toMatch(/\*/);
        expect(gr.access.length).toBeGreaterThan(0);
        expect(g.nodes.some((x) => x.address === gr.target), `${n.address} grants to missing ${gr.target}`).toBe(true);
      }
  });

  it("derives firewall rules only for network capabilities, with the right ports", () => {
    expect(node(g, "firewall/api-to-db").spec).toMatchObject({ port: 5432 });
    expect(node(g, "firewall/api-to-cache").spec).toMatchObject({ port: 6379 });
    expect(node(g, "firewall/worker-to-api").spec).toMatchObject({ port: 8080, capability: "http" });
    expect(node(g, "firewall/nightly-to-db").spec).toMatchObject({ source: { address: "scheduled_job/nightly" } });
    // a static site calls the API from the browser, not from inside the network
    expect(kinds(g, "firewall").some((a) => a.startsWith("firewall/site-"))).toBe(false);
    expect(g.edges).toContainEqual({ from: "static_site/site", to: "container_service/api", relation: "connects_to", detail: "http:8080" });
  });

  it("does not order services after each other for http calls, so mutual callers do not form a cycle", () => {
    const m = manifest({
      services: [svc({ id: "a", name: "aa", kind: "web", port: 1 }), svc({ id: "b", name: "bb", kind: "web", port: 2 })],
      bindings: [bind("x", "a", "b", "http"), bind("y", "b", "a", "http")],
    });
    const gg = expandManifest(m, PROD);
    expect(graphProblems(gg)).toEqual([]);
    expect(kinds(gg, "firewall")).toEqual(["firewall/aa-to-bb", "firewall/bb-to-aa"]);
  });

  it("ignores bindings that do not fit their target, and says so", () => {
    const m = manifest({
      services: [svc({ id: "a", name: "aa", kind: "worker" })],
      resources: [res({ id: "r", name: "cache", kind: "redis" })],
      bindings: [bind("b1", "a", "r", "sql"), bind("b2", "a", "r", "http"), bind("b3", "ghost", "r", "cache"), bind("b4", "a", "ghost", "cache"), bind("b5", "r", "a", "http")],
    });
    const gg = expandManifest(m, PROD);
    expect(kinds(gg, "firewall")).toEqual([]);
    expect(notes(gg, "binding")).toHaveLength(5);
    expect(gg.edges.filter((e) => e.relation === "connects_to")).toEqual([]);
  });

  it("a web service without a port cannot be a target: noted, no rule", () => {
    const m = manifest({
      services: [svc({ id: "a", name: "aa", kind: "worker" }), svc({ id: "b", name: "bb", kind: "web" })],
      bindings: [bind("x", "a", "b", "http")],
    });
    const gg = expandManifest(m, PROD);
    expect(kinds(gg, "firewall")).toEqual([]);
    expect(notes(gg, "binding").some((n) => /bb has no port/.test(n))).toBe(true);
    expect(notes(gg, "workload").some((n) => /container_service\/bb has no port/.test(n))).toBe(true);
  });
});

describe("workloads and sources", () => {
  const g = expandManifest(fullManifest(), PROD);

  it("maps service kinds to primitives and native types", () => {
    expect(node(g, "container_service/api").nativeType).toBe("aws:ecs_service");
    expect(node(g, "container_service/worker").spec).toMatchObject({ workload: "worker" });
    expect(node(g, "scheduled_job/nightly")).toMatchObject({ kind: "scheduled_job", nativeType: "aws:ecs_scheduled_task" });
    expect(node(g, "scheduled_job/nightly").spec).toMatchObject({ schedule: "0 3 * * *" });
    expect(node(g, "static_site/site")).toMatchObject({ kind: "static_site", nativeType: "aws:s3_static_site" });
  });

  it("git sources add a pipeline and (not for static) a registry; image sources add nothing", () => {
    expect(node(g, "build_pipeline/api").spec).toEqual({ source: { repo: "github.com/acme/api", ref: "main", dockerfile: "Dockerfile" }, output: { registry: "container_registry/api" }, location: "customer_account" });
    expect(node(g, "build_pipeline/site").spec).toMatchObject({ output: { staticSite: "static_site/site" } });
    expect(has(g, "container_registry/site")).toBe(false);
    expect(node(g, "container_service/api").spec.artifact).toEqual({ type: "built", pipeline: "build_pipeline/api", registry: "container_registry/api" });
    expect(has(g, "build_pipeline/worker")).toBe(false);
    expect(node(g, "container_service/worker").spec.artifact).toEqual({ type: "image", ref: "ghcr.io/acme/app:1" });
    expect(node(g, "identity/api").spec.grants).toContainEqual({ target: "container_registry/api", access: ["pull"], via: ["image_pull"] });
  });

  it("static sites and cron jobs get the right auxiliary nodes", () => {
    expect(has(g, "identity/site")).toBe(false);
    expect(has(g, "log_group/site")).toBe(false);
    expect(has(g, "log_group/nightly")).toBe(true);
    expect(has(g, "identity/nightly")).toBe(true);
  });

  it("blueprint sources are noted as sandbox-only on real providers", () => {
    const m = manifest({ services: [svc({ id: "s", name: "web", kind: "web", port: 80, source: { type: "blueprint", blueprint: "web" } })] });
    expect(notes(expandManifest(m, PROD), "source")).toHaveLength(1);
    expect(notes(expandManifest(m, { ...PROD, provider: "sandbox", region: "sim-1" }), "source")).toHaveLength(0);
  });

  it("maps size to vcpu/memory and passes replicas, port and health path", () => {
    expect(node(g, "container_service/api").spec).toMatchObject({ size: "standard", vcpu: 1, memoryMb: 1024, replicas: 2, port: 8080, healthPath: "/health", zones: 2, subnetTier: "private" });
  });

  it("email has no portable primitive: skipped with a note, no dangling references", () => {
    expect(has(g, "email/mail")).toBe(false);
    expect(notes(g, "email")).toHaveLength(1);
    expect(graphProblems(g)).toEqual([]);
  });
});

describe("data stores and policies", () => {
  it("applies deletion and backup policies to stateful nodes and says which", () => {
    const g = expandManifest(v2(fullManifest(), { policies: { deletion: "deny", backup: "none" } }), PROD);
    expect(node(g, "postgres/db").spec).toMatchObject({ deletionPolicy: "deny", backup: "none" });
    expect(node(g, "redis/cache").spec).toMatchObject({ deletionPolicy: "deny", backup: "none" });
    expect(node(g, "object_store/assets").spec).toMatchObject({ deletionPolicy: "deny", versioning: false, publicAccess: false, encryption: true });
    expect(node(g, "queue/jobs").spec).toMatchObject({ deletionPolicy: "deny", config: { visibilityTimeout: 60 } });
    expect(notes(g, "policies")[0]).toMatch(/deletion=deny and backup=none apply to object_store\/assets, redis\/cache, postgres\/db, queue\/jobs/);
    expect(node(expandManifest(fullManifest(), PROD), "object_store/assets").spec).toMatchObject({ versioning: true });
  });

  it("postgres version: manifest config wins over providerConfig, which wins over the default", () => {
    expect(node(expandManifest(fullManifest(), PROD), "postgres/db").spec).toMatchObject({ version: "15" });
    expect(node(expandManifest(webDb(), PROD), "postgres/postgres").spec).toMatchObject({ version: "16" });
    const tuned = expandManifest(v2(webDb(), { providerConfig: { aws: { rdsEngineVersion: "14.9", multiAz: true, instanceClassOverrides: { postgres: "db.r6g.large" } } } }), PROD);
    expect(node(tuned, "postgres/postgres").spec).toMatchObject({ version: "14.9", highAvailability: true, instanceClass: "db.r6g.large" });
  });

  it("notes provider config that no node uses", () => {
    const g = expandManifest(v2(webDb(), { providerConfig: { gcp: { highAvailability: true }, kubernetes: { namespace: "x" } } }), PROD);
    expect(notes(g, "providerConfig")).toEqual([
      "providerConfig: providerConfig.gcp is set but no node in this graph is placed on gcp; it has no effect.",
      "providerConfig: providerConfig.kubernetes is set but no node in this graph is placed on kubernetes; it has no effect.",
    ]);
  });

  it("notes constraints it does not evaluate", () => {
    const g = expandManifest(v2(webDb(), { constraints: { budgetUsdMonthly: 100, latencyTargetMs: 50 } }), PROD);
    expect(notes(g, "constraints")).toHaveLength(1);
  });
});

describe("providers", () => {
  it("kubernetes: namespace network, no subnets, k8s native types, unsupported kinds are kept and noted", () => {
    const k8s: ExpandEnv = { ...PROD, provider: "kubernetes", region: "kind-local" };
    const g = expandManifest(v2(webDb(), { providerConfig: { kubernetes: { namespace: "acme", ingressClass: "nginx" } } }), k8s);
    expect(node(g, "network/main")).toMatchObject({ nativeType: "k8s:Namespace", spec: { namespace: "acme", zones: 2 } });
    expect(kinds(g, "subnet")).toEqual([]);
    expect(node(g, "container_service/web").nativeType).toBe("k8s:Deployment");
    expect(node(g, "postgres/postgres").nativeType).toBe("k8s:StatefulSet");
    expect(node(g, "load_balancer/public")).toMatchObject({ nativeType: "k8s:Ingress", spec: { ingressClass: "nginx" } });
    expect(node(g, "container_service/web").dependsOn).toContain("network/main");
    // log groups have no kubernetes primitive: kept, never dropped
    expect(node(g, "log_group/web").nativeType).toBe("unsupported:kubernetes:log_group");
    expect(notes(g, "unsupported").some((n) => /log_group\/web has no native mapping on kubernetes.*unsupported:kubernetes:log_group/.test(n))).toBe(true);
    expect(graphProblems(g)).toEqual([]);
  });

  it("kubernetes namespace defaults from the environment name", () => {
    const g = expandManifest(webDb(), { ...STAGING, provider: "kubernetes", region: "kind" });
    expect(node(g, "network/main").spec).toEqual({ namespace: "zenith-staging", zones: 1 });
  });

  it("every provider expands every blueprint into a valid graph, unmapped kinds visible not dropped", () => {
    const providers: ExpandEnv[] = [
      { ...PROD, provider: "aws" },
      { ...PROD, provider: "gcp", region: "us-central1" },
      { ...PROD, provider: "azure", region: "eastus" },
      { ...PROD, provider: "oci", region: "ap-mumbai-1" },
      { ...PROD, provider: "kubernetes", region: "kind" },
      { ...PROD, provider: "zenith", region: "zenith-1" },
      { ...PROD, provider: "sandbox", region: "sim-1" },
      { ...PROD, provider: "localstack", region: "us-east-1" },
    ];
    for (const env of providers)
      for (const bp of blueprints) {
        const g = expandManifest(bp.manifestFactory("acme"), env);
        expect(graphProblems(g), `${env.provider}/${bp.id}`).toEqual([]);
        for (const n of g.nodes) expect(n.provider).toBe(env.provider);
        for (const n of g.nodes.filter((x) => x.nativeType.startsWith("unsupported:")))
          expect(notes(g, "unsupported").some((t) => t.includes(n.address)), `${env.provider}/${bp.id}/${n.address}`).toBe(true);
      }
  });

  it("sandbox keeps its own vocabulary", () => {
    const g = expandManifest(webDb(), { ...PROD, provider: "sandbox", region: "sim-1" });
    expect(node(g, "container_service/web").nativeType).toBe("sandbox:container_service");
    expect(kinds(g, "container_service").length).toBe(1);
  });

  it("localstack maps only what it emulates and marks the rest unsupported", () => {
    const m = manifest({ resources: [res({ id: "r1", name: "assets", kind: "object_store" }), res({ id: "r2", name: "jobs", kind: "queue" }), res({ id: "r3", name: "db", kind: "postgres" })] });
    const g = expandManifest(m, { ...PROD, provider: "localstack" });
    expect(node(g, "object_store/assets").nativeType).toBe("localstack:s3_bucket");
    expect(node(g, "queue/jobs").nativeType).toBe("localstack:sqs_queue");
    expect(node(g, "postgres/db").nativeType).toBe("unsupported:localstack:postgres");
  });
});

describe("multi-cloud placement", () => {
  const base = manifest({
    services: [svc({ id: "svc-web", name: "web", kind: "web", port: 3000 })],
    resources: [res({ id: "res-db", name: "db", kind: "postgres" }), res({ id: "res-files", name: "files", kind: "object_store" })],
    routes: [route({ id: "rt", host: "app.example.com" })],
    bindings: [bind("b0", "rt", "svc-web", "http"), bind("b1", "svc-web", "res-db", "sql"), bind("b2", "svc-web", "res-files", "blob")],
  });

  it("moves a node to another provider, gives it its own network, and notes each crossing edge as cross_cloud", () => {
    const g = expandManifest(v2(base, { nodePlacement: { db: { provider: "gcp", region: "europe-west1" } } }), PROD);
    const db = node(g, "postgres/db");
    expect(db).toMatchObject({ provider: "gcp", region: "europe-west1", nativeType: "gcp:cloud_sql_instance" });
    expect(kinds(g, "network")).toEqual(["network/gcp-europe-west1", "network/main"]);
    expect(node(g, "network/gcp-europe-west1")).toMatchObject({ provider: "gcp", region: "europe-west1", nativeType: "gcp:vpc_network" });
    expect(node(g, "network/gcp-europe-west1").spec).toMatchObject({ cidr: "10.1.0.0/16" });
    expect(node(g, "network/main").spec).toMatchObject({ cidr: "10.0.0.0/16" });
    expect(db.dependsOn).toEqual(["subnet/gcp-europe-west1-private-a", "subnet/gcp-europe-west1-private-b"]);
    expect(node(g, "subnet/gcp-europe-west1-private-a")).toMatchObject({ provider: "gcp", nativeType: "gcp:subnetwork" });
    const cross = notes(g, "cross_cloud");
    expect(cross).toHaveLength(1);
    expect(cross[0]).toMatch(/container_service\/web \(aws\/us-east-1\) → postgres\/db \(gcp\/europe-west1\) via connects_to sql:5432/);
    const fw = node(g, "firewall/web-to-db");
    expect(fw).toMatchObject({ provider: "gcp", region: "europe-west1" });
    expect(fw.spec).toMatchObject({ crossBoundary: "cross_cloud" });
    expect(notes(g, "cross_region")).toEqual([]);
    expect(graphProblems(g)).toEqual([]);
  });

  it("a same-provider region move is cross_region, not cross_cloud", () => {
    const g = expandManifest(v2(base, { nodePlacement: { "res-files": { provider: "aws", region: "eu-west-1" }, db: { provider: "aws", region: "eu-west-1" } } }), PROD);
    expect(node(g, "object_store/files").region).toBe("eu-west-1");
    expect(notes(g, "cross_cloud")).toEqual([]);
    const cross = notes(g, "cross_region");
    expect(cross).toHaveLength(2);
    expect(cross.some((n) => /object_store\/files \(aws\/eu-west-1\).*connects_to blob/.test(n))).toBe(true);
    expect(node(g, "firewall/web-to-db").spec).toMatchObject({ crossBoundary: "cross_region" });
    expect(kinds(g, "network")).toEqual(["network/aws-eu-west-1", "network/main"]);
  });

  it("a nodePlacement without a region needs one from somewhere, else expansion refuses", () => {
    expect(() => expandManifest(v2(base, { nodePlacement: { db: { provider: "gcp" } } }), PROD)).toThrow(/names provider gcp but no region/);
    const viaPlacement = expandManifest(v2(base, { placement: { provider: "gcp", regions: ["us-central1"] }, nodePlacement: { db: { provider: "gcp" } } }), PROD);
    expect(node(viaPlacement, "postgres/db").region).toBe("us-central1");
    const sameProvider = expandManifest(v2(base, { nodePlacement: { db: { provider: "aws" } } }), PROD);
    expect(node(sameProvider, "postgres/db").region).toBe("us-east-1");
    expect(notes(sameProvider, "cross_region")).toEqual([]);
  });

  it("uses the target provider's providerConfig for the moved node's network", () => {
    const g = expandManifest(v2(base, { nodePlacement: { db: { provider: "gcp", region: "europe-west1" } }, providerConfig: { gcp: { vpcCidr: "10.77.0.0/16", cloudSqlTier: "db-custom-2-7680", highAvailability: true } } }), PROD);
    expect(node(g, "network/gcp-europe-west1").spec).toMatchObject({ cidr: "10.77.0.0/16" });
    expect(node(g, "postgres/db").spec).toMatchObject({ instanceClass: "db-custom-2-7680", highAvailability: true });
  });

  it("moving the web service off the load balancer's provider flags the routing edge and the lb → service rule", () => {
    const g = expandManifest(v2(base, { nodePlacement: { web: { provider: "gcp", region: "us-central1" } } }), PROD);
    expect(node(g, "container_service/web")).toMatchObject({ provider: "gcp", nativeType: "gcp:cloud_run_service" });
    expect(node(g, "load_balancer/public")).toMatchObject({ provider: "aws", region: "us-east-1" });
    expect(notes(g, "cross_cloud").some((n) => /load_balancer\/public \(aws\/us-east-1\) → container_service\/web \(gcp\/us-central1\) via routes_to/.test(n))).toBe(true);
    expect(node(g, "firewall/lb-to-web").spec).toMatchObject({ crossBoundary: "cross_cloud" });
    // db and files stay on aws while web is on gcp: two more crossings
    expect(notes(g, "cross_cloud").length).toBe(3);
    expect(graphProblems(g)).toEqual([]);
  });

  it("environment placement wins over the manifest's placement, with a note", () => {
    expect(notes(expandManifest(v2(base, { placement: { provider: "gcp", regions: ["us-central1"] } }), PROD), "placement")[0]).toMatch(/placement\.provider is gcp but this environment runs on aws/);
    expect(notes(expandManifest(v2(base, { placement: { provider: "aws", regions: ["eu-west-1"] } }), PROD), "placement")[0]).toMatch(/environment region us-east-1 is not in placement\.regions/);
    expect(notes(expandManifest(v2(base, { placement: { provider: "auto", regions: [] } }), PROD), "placement")[0]).toMatch(/placement\.provider is auto/);
  });
});

describe("native nodes", () => {
  const withNative = (over: Record<string, unknown> = {}) =>
    v2(webDb(), {
      native: [{ id: "topic", provider: "aws", type: "aws:dynamodb_table", config: { hashKey: { name: "pk", type: "S" } }, dependsOn: ["web", "postgres"], ...over }],
    } as Partial<ManifestV2>);

  it("becomes a provider_native node with parsed config, resolved dependencies and a note", () => {
    const g = expandManifest(withNative(), PROD);
    const n = node(g, "provider_native/topic");
    expect(n).toMatchObject({ kind: "provider_native", nativeType: "aws:dynamodb_table", provider: "aws", region: "us-east-1", ownership: "managed", origin: ["topic"] });
    expect(n.spec).toEqual({ type: "aws:dynamodb_table", config: { hashKey: { name: "pk", type: "S" }, billingMode: "PAY_PER_REQUEST" } });
    expect(n.dependsOn).toEqual(["container_service/web", "postgres/postgres"]);
    expect(notes(g, "native")).toHaveLength(1);
    expect(graphProblems(g)).toEqual([]);
  });

  it("needs a resolvable region when its provider is not the environment's", () => {
    expect(() => expandManifest(withNative({ provider: "gcp", type: "gcp:pubsub_topic", config: {} }), PROD)).toThrow(/has no region/);
    const g = expandManifest(withNative({ provider: "gcp", type: "gcp:pubsub_topic", config: {}, region: "europe-west1" }), PROD);
    expect(node(g, "provider_native/topic")).toMatchObject({ provider: "gcp", region: "europe-west1", nativeType: "gcp:pubsub_topic" });
  });

  it("cannot be re-placed onto another provider, and never accepts inline secrets or unknown types", () => {
    expect(() => expandManifest({ ...withNative(), nodePlacement: { topic: { provider: "gcp", region: "x1" } } }, PROD)).toThrow(/cannot change provider/);
    expect(() => expandManifest(withNative({ type: "aws:not_registered", config: {} }), PROD)).toThrow(ManifestExpansionError);
    expect(() => expandManifest(withNative({ config: { hashKey: { name: "pk", type: "S" }, apiToken: "abc" } }), PROD)).toThrow(/looks like an inline secret value/);
  });

  it("drops a dependency it cannot resolve, with a note", () => {
    const g = expandManifest(withNative({ dependsOn: ["ghost", "web"] }), PROD);
    expect(node(g, "provider_native/topic").dependsOn).toEqual(["container_service/web"]);
    expect(notes(g, "native").some((n) => /depends on "ghost"/.test(n))).toBe(true);
  });
});

describe("input that cannot be addressed", () => {
  it("rejects duplicate ids, duplicate names, and names or hosts that would corrupt addresses", () => {
    expect(() => expandManifest(manifest({ services: [svc({ id: "x", name: "aa", kind: "web" }), svc({ id: "x", name: "bb", kind: "web" })] }), PROD)).toThrow(/Duplicate manifest node id "x"/);
    expect(() => expandManifest(manifest({ services: [svc({ id: "1", name: "aa", kind: "web" }), svc({ id: "2", name: "aa", kind: "web" })] }), PROD)).toThrow(/share the name "aa"/);
    expect(() => expandManifest(manifest({ resources: [res({ id: "1", name: "db", kind: "queue" }), res({ id: "2", name: "db", kind: "redis" })] }), PROD)).toThrow(/share the name "db"/);
    expect(() => expandManifest(manifest({ services: [svc({ id: "1", name: "a/b", kind: "web" })] }), PROD)).toThrow(/not a valid node name/);
    expect(() => expandManifest(manifest({ routes: [route({ id: "r", host: "a.com/../x" })] }), PROD)).toThrow(/not a plain hostname/);
  });
});

describe("determinism", () => {
  it("expanding twice yields byte-identical output", () => {
    const a = JSON.stringify(expandManifest(fullManifest(), PROD));
    const b = JSON.stringify(expandManifest(fullManifest(), PROD));
    expect(a).toBe(b);
  });

  it("shuffling every input list changes nothing: same graphDigest, same bytes, same notes", () => {
    for (const { name, manifest: m } of v1Fixtures()) {
      const base = expandManifest(m, PROD);
      for (const seed of [1, 2, 3]) {
        const shuffled = expandManifest(shuffledManifest(m, seed), PROD);
        expect(shuffled.graphDigest, `${name}#${seed}`).toBe(base.graphDigest);
        expect(shuffled.manifestDigest, `${name}#${seed} manifestDigest`).toBe(base.manifestDigest);
        expect(JSON.stringify(shuffled), `${name}#${seed}`).toBe(JSON.stringify(base));
      }
    }
  });

  it("object key order in config and native config never reaches the output bytes", () => {
    const mk = (configOrder: 1 | 2, nativeOrder: 1 | 2, listOrder: 1 | 2): ManifestV2 => {
      const m = manifest({
        resources: [
          res({ id: "r1", name: "db", kind: "postgres", config: configOrder === 1 ? { version: "15", zeta: 1, alpha: true } : { alpha: true, zeta: 1, version: "15" } }),
        ],
      });
      const natives = [
        { id: "tbl-one", provider: "aws" as const, type: "aws:dynamodb_table", config: nativeOrder === 1 ? { hashKey: { name: "pk", type: "S" }, billingMode: "PROVISIONED" } : { billingMode: "PROVISIONED", hashKey: { type: "S", name: "pk" } } },
        { id: "topic-a", provider: "aws" as const, type: "aws:sns_topic", config: {}, dependsOn: ["db", "tbl-one"] },
      ];
      return {
        ...upgradeManifest(m, { provider: "aws", region: "us-east-1" }),
        native: listOrder === 1 ? natives : [...natives].reverse(),
        nodePlacement: listOrder === 1 ? { db: { provider: "aws", region: "us-east-1" }, "tbl-one": { provider: "aws", region: "us-east-1" } } : { "tbl-one": { region: "us-east-1", provider: "aws" }, db: { region: "us-east-1", provider: "aws" } },
      };
    };
    const a = expandManifest(mk(1, 1, 1), PROD);
    for (const [c, n, l] of [[2, 1, 1], [1, 2, 1], [1, 1, 2], [2, 2, 2]] as const) {
      const b = expandManifest(mk(c, n, l), PROD);
      expect(JSON.stringify(b), `${c}${n}${l}`).toBe(JSON.stringify(a));
      expect(b.manifestDigest).toBe(a.manifestDigest);
    }
    expect(node(a, "postgres/db").spec.config).toEqual({ alpha: true, version: "15", zeta: 1 });
    expect(Object.keys(node(a, "postgres/db").spec.config as object)).toEqual(["alpha", "version", "zeta"]);
    expect(node(a, "provider_native/topic-a").dependsOn).toEqual(["postgres/db", "provider_native/tbl-one"]);
  });

  it("expanding a V1 manifest and its lossless V2 upgrade gives the same nodes and edges", () => {
    for (const { name, manifest: m } of v1Fixtures().slice(0, 60)) {
      const a = expandManifest(m, PROD);
      const b = expandManifest(upgradeManifest(m, { provider: "aws", region: "us-east-1" }), PROD);
      expect(b.graphDigest, name).toBe(a.graphDigest);
      expect(b.notes, name).toEqual(a.notes);
    }
  });

  it("a real change moves the digest; an irrelevant reorder does not", () => {
    const m = webDb();
    const base = expandManifest(m, PROD);
    const bigger = webDb();
    bigger.services[0].replicas = 3;
    const changed = expandManifest(bigger, PROD);
    expect(changed.graphDigest).not.toBe(base.graphDigest);
    expect(changed.manifestDigest).not.toBe(base.manifestDigest);
    expect(node(changed, "container_service/web").specDigest).not.toBe(node(base, "container_service/web").specDigest);
    expect(node(changed, "postgres/postgres").specDigest).toBe(node(base, "postgres/postgres").specDigest);
    const otherEnv = expandManifest(m, STAGING);
    expect(otherEnv.graphDigest).not.toBe(base.graphDigest);
  });

  it("holds the structural invariants for every fixture on aws", () => {
    for (const { name, manifest: m } of v1Fixtures()) expect(graphProblems(expandManifest(m, PROD)), name).toEqual([]);
  });

  it("stays fast and valid on a large manifest", () => {
    const services = Array.from({ length: 150 }, (_, i) => svc({ id: `s${i}`, name: `svc-${i}`, kind: i % 5 === 0 ? "worker" : "web", port: 3000 + i }));
    const resources = Array.from({ length: 60 }, (_, i) => res({ id: `r${i}`, name: `data-${i}`, kind: (["postgres", "redis", "object_store", "queue"] as const)[i % 4] }));
    const caps = { postgres: "sql", redis: "cache", object_store: "blob", queue: "queue_publish" } as const;
    const routes = services.filter((s) => s.kind === "web").map((s, i) => route({ id: `rt${i}`, host: `h${i}.example.com` }));
    const bindings = [
      ...routes.map((r, i) => bind(`br${i}`, r.id, services.filter((s) => s.kind === "web")[i].id, "http")),
      ...services.flatMap((s, i) => [0, 1, 2].map((k) => bind(`b${i}-${k}`, s.id, resources[(i + k * 7) % resources.length].id, caps[resources[(i + k * 7) % resources.length].kind as keyof typeof caps]))),
    ];
    const big = manifest({ services, resources, routes, bindings });
    const t0 = Date.now();
    const g = expandManifest(big, PROD);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(g.nodes.length).toBeGreaterThan(500);
    expect(graphProblems(g)).toEqual([]);
    expect(expandManifest(shuffledManifest(big, 5), PROD).graphDigest).toBe(g.graphDigest);
  });

  it("does not mutate its input", () => {
    for (const { name, manifest: m } of v1Fixtures().slice(0, 30)) {
      const before = structuredClone(m);
      expandManifest(m, PROD);
      expect(m, name).toStrictEqual(before);
    }
  });
});
