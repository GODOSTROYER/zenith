/**
 * Shared test support for the Azure provider: node builders that mimic what
 * `expandManifest()` emits, a compile harness, a fake Entra endpoint and a
 * fake ARM server (a real local HTTP server that the session's `fetchImpl`
 * redirects `https://management.azure.com` to, so status codes, headers and
 * Retry-After behave like the wire).
 *
 * Everything here is contract-level: no Azure account is involved anywhere.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAzureSession, type AzureSessionHandle } from "@/lib/providers/azure/credentials";
import type { CompileContext, DriverContext, TofuFragment } from "@/lib/drivers/types";
import type { AzureConnectionConfig } from "@/lib/credentials/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { digest } from "@/lib/controlplane/digest";

export const SUB = "11111111-2222-3333-4444-555555555555";
export const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
export const CLIENT = "99999999-8888-7777-6666-555555555555";
export const ENV_ID = "env_azure_1";
export const REGION = "westeurope";

export const connection: AzureConnectionConfig = {
  provider: "azure",
  mode: "oidc_web_identity",
  tenantId: TENANT,
  clientId: CLIENT,
  subscriptionId: SUB,
  region: REGION,
};

/* --------------------------------- nodes ---------------------------------- */

export function mkNode(address: string, kind: ResourceNode["kind"], nativeType: string, spec: Record<string, unknown>, over: Partial<ResourceNode> = {}): ResourceNode {
  const node: ResourceNode = {
    address,
    kind,
    provider: "azure",
    region: REGION,
    nativeType,
    ownership: "managed",
    spec,
    origin: [address],
    dependsOn: [],
    specDigest: "",
    labels: { "zenith:environment": ENV_ID, "zenith:managed": "true", "zenith:resource": address },
    ...over,
  };
  node.specDigest = digest({ kind, nativeType, spec });
  return node;
}

export function compileContext(nodes: ResourceNode[]): CompileContext {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  return {
    environmentId: ENV_ID,
    namePrefix: "zn-k3x9q2",
    region: REGION,
    tags: { "zenith:workspace": "ws_1", "zenith:environment": ENV_ID, "zenith:managed": "true" },
    ref: () => {
      throw new Error("Azure drivers must not use ctx.ref; they use exports.");
    },
    node: (a) => byAddress.get(a),
  };
}

export function graphOf(nodes: ResourceNode[]): ResourceGraph {
  return { version: 1, environmentId: ENV_ID, manifestDigest: "m".repeat(8), nodes, edges: [], graphDigest: "g".repeat(8), notes: [] };
}

/** A typical manifest expansion for Azure: web service with a secret, postgres, redis, bucket, queue, route + tls + dns. */
export function sampleGraph(): ResourceNode[] {
  const privateSubnets = ["subnet/private-a", "subnet/private-b"];
  const nodes: ResourceNode[] = [
    mkNode("network/main", "network", "azure:virtual_network", { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "single" } }),
    mkNode("subnet/public-a", "subnet", "azure:subnet", { tier: "public", zone: "a", cidr: "10.0.0.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("subnet/public-b", "subnet", "azure:subnet", { tier: "public", zone: "b", cidr: "10.0.1.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("subnet/private-a", "subnet", "azure:subnet", { tier: "private", zone: "a", cidr: "10.0.10.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("subnet/private-b", "subnet", "azure:subnet", { tier: "private", zone: "b", cidr: "10.0.11.0/24", network: "network/main" }, { dependsOn: ["network/main"] }),
    mkNode("log_group/web", "log_group", "azure:log_analytics_workspace", { workload: "container_service/web", retentionDays: 30 }),
    mkNode(
      "identity/web",
      "identity",
      "azure:user_assigned_identity",
      {
        principal: "workload",
        workload: "container_service/web",
        grants: [
          { target: "container_registry/web", access: ["pull"], via: ["image_pull"] },
          { target: "log_group/web", access: ["write"], via: ["own_log_group"] },
          { target: "object_store/uploads", access: ["delete", "list", "read", "write"], via: ["binding:blob"] },
          { target: "postgres/db", access: ["read_credentials"], via: ["binding:sql"] },
          { target: "queue/jobs", access: ["publish"], via: ["binding:queue_publish"] },
          { target: "secret/session-key-1a2b3c4d", access: ["read"], via: ["env:SESSION_KEY"] },
        ],
      },
      { dependsOn: ["container_registry/web", "log_group/web", "object_store/uploads", "postgres/db", "queue/jobs", "secret/session-key-1a2b3c4d"] }
    ),
    mkNode("secret/session-key-1a2b3c4d", "secret", "azure:key_vault_secret", { secretRef: "vault:ws_1/env_azure_1/SESSION_KEY", store: "zenith_vault", purpose: "environment" }),
    mkNode("container_registry/web", "container_registry", "azure:container_registry", { scanOnPush: true, immutableTags: false }),
    mkNode("build_pipeline/web", "build_pipeline", "azure:acr_task", { source: { repo: "https://github.com/acme/web", ref: "main" }, output: { registry: "container_registry/web" }, location: "customer_account" }, { dependsOn: ["container_registry/web"] }),
    mkNode(
      "postgres/db",
      "postgres",
      "azure:postgresql_flexible_server",
      { size: "standard", deletionPolicy: "approval", encryption: true, engine: "postgres", version: "16", highAvailability: true, backup: "daily", credentials: "generated", subnetTier: "private", zones: 2 },
      { dependsOn: privateSubnets }
    ),
    mkNode(
      "redis/cache",
      "redis",
      "azure:redis_cache",
      { size: "small", deletionPolicy: "approval", encryption: true, engine: "redis", highAvailability: false, backup: "none", subnetTier: "private", zones: 2 },
      { dependsOn: privateSubnets }
    ),
    mkNode("object_store/uploads", "object_store", "azure:storage_container", { size: "small", deletionPolicy: "approval", encryption: true, versioning: true, publicAccess: false }),
    mkNode("queue/jobs", "queue", "azure:service_bus_queue", { size: "small", deletionPolicy: "approval", encryption: true }),
    mkNode(
      "container_service/web",
      "container_service",
      "azure:container_app",
      {
        size: "small",
        vcpu: 0.5,
        memoryMb: 512,
        artifact: { type: "built", pipeline: "build_pipeline/web", registry: "container_registry/web" },
        env: [
          { key: "NODE_ENV", value: "production" },
          { key: "SESSION_KEY", secretRef: "vault:ws_1/env_azure_1/SESSION_KEY" },
        ],
        zones: 2,
        subnetTier: "private",
        workload: "web",
        replicas: 2,
        port: 8080,
        healthPath: "/healthz",
      },
      { dependsOn: [...privateSubnets, "log_group/web", "identity/web", "build_pipeline/web", "postgres/db", "redis/cache", "secret/session-key-1a2b3c4d"] }
    ),
    mkNode(
      "scheduled_job/report",
      "scheduled_job",
      "azure:container_app_job",
      { size: "nano", vcpu: 0.25, memoryMb: 256, artifact: { type: "image", ref: "ghcr.io/acme/report:1.4.2" }, env: [{ key: "MODE", value: "nightly" }], zones: 2, subnetTier: "private", schedule: "0 2 * * *" },
      { dependsOn: [...privateSubnets] }
    ),
    mkNode(
      "load_balancer/public",
      "load_balancer",
      "azure:application_gateway",
      {
        scheme: "internet-facing",
        tier: "public",
        listeners: [
          { port: 80, protocol: "http", redirectToHttps: true },
          { port: 443, protocol: "https" },
        ],
        routes: [{ host: "app.example.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080, healthPath: "/healthz" }],
      },
      { dependsOn: ["subnet/public-a", "subnet/public-b", "tls_certificate/app.example.com"] }
    ),
    mkNode("dns_zone/example.com", "dns_zone", "azure:dns_zone", { name: "example.com", private: false }, { ownership: "referenced", externalRef: `/subscriptions/${SUB}/resourceGroups/dns-rg/providers/Microsoft.Network/dnszones/example.com` }),
    mkNode("dns_record/app.example.com", "dns_record", "azure:dns_record_set", { name: "app.example.com", type: "alias", target: "load_balancer/public", zone: "dns_zone/example.com" }, { dependsOn: ["load_balancer/public", "dns_zone/example.com"] }),
    mkNode("tls_certificate/app.example.com", "tls_certificate", "azure:managed_certificate", { domain: "app.example.com", validation: "dns_automatic", zone: "dns_zone/example.com" }, { dependsOn: ["dns_zone/example.com"] }),
    mkNode("firewall/internet-to-lb-80", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 80, source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "public_http", description: "the public internet reaches the load balancer on tcp/80" }, { dependsOn: ["load_balancer/public"] }),
    mkNode("firewall/internet-to-lb-443", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 443, source: { cidr: "0.0.0.0/0" }, target: "load_balancer/public", capability: "public_http", description: "the public internet reaches the load balancer on tcp/443" }, { dependsOn: ["load_balancer/public"] }),
    mkNode("firewall/lb-to-web", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 8080, source: { address: "load_balancer/public" }, target: "container_service/web", capability: "http", description: "the load balancer reaches web on tcp/8080" }, { dependsOn: ["load_balancer/public", "container_service/web"] }),
    mkNode("firewall/web-to-db", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 5432, source: { address: "container_service/web" }, target: "postgres/db", capability: "sql", description: "web reaches db (sql) on tcp/5432" }, { dependsOn: ["container_service/web", "postgres/db"] }),
    mkNode("firewall/web-to-cache", "firewall", "azure:network_security_rule", { direction: "ingress", protocol: "tcp", port: 6379, source: { address: "container_service/web" }, target: "redis/cache", capability: "cache", description: "web reaches cache (cache) on tcp/6379" }, { dependsOn: ["container_service/web", "redis/cache"] }),
  ];
  return nodes;
}

export function compileAll(nodes: ResourceNode[], getDriver: (n: ResourceNode) => { compile?: (n: ResourceNode, c: CompileContext) => TofuFragment } | undefined): Map<string, TofuFragment> {
  const ctx = compileContext(nodes);
  const out = new Map<string, TofuFragment>();
  for (const n of nodes) {
    const d = getDriver(n);
    if (d?.compile) out.set(n.address, d.compile(n, ctx));
  }
  return out;
}

/* ------------------------------ fake Entra -------------------------------- */

export interface FakeEntra {
  fetchImpl: typeof fetch;
  requests: { url: string; body: URLSearchParams }[];
  /** make the next exchanges fail */
  failWith?: { status: number; body: unknown };
  tokens: string[];
}

/** An Entra token endpoint that issues a distinct opaque token per exchange. */
export function fakeEntra(over: Partial<{ expiresIn: number; failWith: FakeEntra["failWith"] }> = {}): FakeEntra {
  const state: FakeEntra = { fetchImpl: fetch, requests: [], tokens: [], failWith: over.failWith };
  let n = 0;
  state.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = new URLSearchParams(String(init?.body ?? ""));
    state.requests.push({ url, body });
    if (!url.startsWith("https://login.microsoftonline.com/") || !url.endsWith("/oauth2/v2.0/token")) return new Response("{}", { status: 404 });
    if (state.failWith) return new Response(JSON.stringify(state.failWith.body), { status: state.failWith.status, headers: { "content-type": "application/json" } });
    n++;
    const token = `entra-access-token-${n}-${"x".repeat(24)}-${body.get("scope")}`;
    state.tokens.push(token);
    return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: over.expiresIn ?? 3599 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

/** A structurally JWT-shaped assertion with a given expiry (unsigned: the fake Entra does not verify). */
export function fakeAssertion(expUnixSec: number, sub = "zenith:ws:ws_1:conn:conn_1", nonce = "0"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({ iss: "https://zenith.example/api/oidc", sub, aud: "api://AzureADTokenExchange", exp: expUnixSec, jti: nonce })}.c2lnbmF0dXJlLXBhZGRpbmctMTIzNDU2Nzg5MA`;
}

/* -------------------------------- fake ARM -------------------------------- */

export interface ArmRoute {
  method?: string;
  /** matches `pathname` exactly (lowercased) or by predicate */
  match: string | ((pathname: string, query: URLSearchParams) => boolean);
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** dynamic response */
  handler?: (req: { method: string; pathname: string; query: URLSearchParams; body: string; headers: http.IncomingHttpHeaders }) => { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };
}

export interface FakeArm {
  fetchImpl: typeof fetch;
  requests: { method: string; pathname: string; query: URLSearchParams; body: string; authorization?: string }[];
  routes: ArmRoute[];
  close(): Promise<void>;
}

/**
 * A local HTTP server standing in for ARM (and the other allowlisted Azure
 * hosts). The returned `fetchImpl` answers Entra token requests itself and
 * forwards every `https://<allowed host>/…` call to the server, preserving
 * method, headers and body.
 */
export async function fakeArm(routes: ArmRoute[] = [], entra: FakeEntra = fakeEntra()): Promise<FakeArm> {
  const state: FakeArm = { fetchImpl: fetch, requests: [], routes, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = Buffer.concat(chunks).toString("utf8");
      const method = (req.method ?? "GET").toUpperCase();
      state.requests.push({ method, pathname: url.pathname, query: url.searchParams, body, authorization: req.headers.authorization as string | undefined });
      const route = state.routes.find(
        (r) => (!r.method || r.method.toUpperCase() === method) && (typeof r.match === "string" ? url.pathname.toLowerCase() === r.match.toLowerCase() : r.match(url.pathname, url.searchParams))
      );
      const out = route?.handler ? route.handler({ method, pathname: url.pathname, query: url.searchParams, body, headers: req.headers }) : route ? { status: route.status ?? 200, body: route.body, headers: route.headers } : { status: 404, body: { error: { code: "ResourceNotFound", message: `no route for ${method} ${url.pathname}` } } };
      res.writeHead(out.status, { "content-type": "application/json", "x-ms-request-id": "req-fake-1", ...(out.headers ?? {}) });
      res.end("raw" in out && out.raw !== undefined ? out.raw : out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  state.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://login.microsoftonline.com/")) return entra.fetchImpl(input, init);
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, redirect: "manual" });
  }) as typeof fetch;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

export async function sessionFor(arm: FakeArm, entra?: FakeEntra, purpose: "observe" | "deploy" = "observe", now?: () => Date): Promise<AzureSessionHandle> {
  let n = 0;
  return createAzureSession({
    connection,
    purpose,
    fetchImpl: arm.fetchImpl,
    now,
    mintClientAssertion: async () => fakeAssertion(Math.floor(Date.now() / 1000) + 300, "zenith:ws:ws_1:conn:conn_1", String(++n)),
  });
}

export function driverContext(session: AzureSessionHandle, over: Partial<DriverContext<AzureSessionHandle>> = {}): DriverContext<AzureSessionHandle> {
  return {
    provider: "azure",
    region: REGION,
    workspaceId: "ws_1",
    environmentId: ENV_ID,
    operationId: "op_1",
    session,
    signal: new AbortController().signal,
    log: () => undefined,
    tags: { "zenith:workspace": "ws_1", "zenith:environment": ENV_ID, "zenith:managed": "true" },
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    ...over,
  };
}
