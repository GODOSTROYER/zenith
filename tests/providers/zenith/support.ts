/**
 * Test doubles and builders for the Zenith-managed provider's tests.
 *
 * HONESTY ABOUT THE DOUBLES. `FakeToolkit` stands in for the Kubernetes
 * provider (WS-K8S), which is not merged on this branch. Its `renderGraph`
 * mirrors the SHAPE of the real renderer for the kinds exercised (restricted pod
 * specs, `managed-by` / `zenith.dev/*` ownership marks, Ingress from routes, a
 * StatefulSet for postgres) so this module's pipeline is exercised on realistic
 * input. It is not the real renderer and no test here proves the real renderer
 * or a real API server accepts anything. `FakeNeon` is a real local HTTP server
 * shaped from Neon's public OpenAPI document; it is not Neon.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { digest } from "@/lib/controlplane/digest";
import { resolveNativeType } from "@/lib/resources/native-types";
import type { PortableKind, ResourceNode } from "@/lib/resources/types";
import type {
  K8sObject,
  KubernetesToolkit,
  ObjectRef,
  ToolkitApplyOptions,
  ToolkitApplyReport,
  ToolkitListQuery,
  ToolkitListResult,
  ToolkitRenderBase,
} from "@/lib/providers/zenith/k8s-port";
import { OWNERSHIP } from "@/lib/providers/zenith/k8s-port";
import type { ConnectionSecretSink, ManagedDatabaseProvider } from "@/lib/providers/zenith/database";
import { readSubstrateConfig, type ZenithEnv, type ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import type { ZenithSession } from "@/lib/providers/zenith/session";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ZenithTenant } from "@/lib/providers/zenith/types";

/* ---------------------------------- config --------------------------------- */

export const FULL_ENV: ZenithEnv = {
  ZENITH_MANAGED_CLUSTER_SERVER: "https://k8s.managed.example.com:6443",
  ZENITH_MANAGED_CLUSTER_CA_DATA: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t",
  ZENITH_MANAGED_KUBECONFIG_REF: "vault:zenith-managed/kubeconfig",
  ZENITH_MANAGED_APP_DOMAIN: "apps.example.com",
  ZENITH_MANAGED_REGISTRY: "registry.example.com/zenith",
  ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT: "https://s3.example.com",
  ZENITH_MANAGED_OBJECT_STORAGE_BUCKET: "zenith-tenants",
  ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF: "vault:zenith-managed/object-store",
  ZENITH_MANAGED_DB_PROVIDER: "neon",
  ZENITH_MANAGED_DB_API_KEY_REF: "vault:zenith-managed/neon-api-key",
  ZENITH_MANAGED_DB_REGION: "aws-us-east-2",
  ZENITH_MANAGED_DB_EGRESS: "0.0.0.0/0:5432",
};

export function substrate(env: ZenithEnv = FULL_ENV): ZenithSubstrate {
  const cfg = readSubstrateConfig(env);
  if (!cfg.configured) throw new Error(`test substrate is not configured: ${cfg.message}`);
  return cfg.substrate;
}

export const TENANT: ZenithTenant = {
  workspaceId: "ws_7f3a9c",
  environmentId: "env_b12e04",
  workspaceSlug: "acme",
  environmentSlug: "production",
  planTier: "starter",
};

export const NS = tenantNamespace(TENANT.workspaceId, TENANT.environmentId);

/* ---------------------------------- nodes ---------------------------------- */

export function mkNode(address: string, kind: PortableKind, spec: Record<string, unknown>, extra: Partial<ResourceNode> = {}): ResourceNode {
  const provider = extra.provider ?? "zenith";
  return {
    address,
    kind,
    provider,
    region: "zenith-managed",
    nativeType: extra.nativeType ?? resolveNativeType(provider, kind).nativeType,
    ownership: "managed",
    spec,
    origin: [],
    dependsOn: [],
    specDigest: digest({ kind, spec }),
    labels: {},
    ...extra,
  };
}

export const WEB = mkNode("container_service/web", "container_service", {
  workload: "web",
  size: "small",
  vcpu: 0.25,
  memoryMb: 512,
  replicas: 2,
  port: 8080,
  healthPath: "/healthz",
  zones: 1,
  subnetTier: "private",
  artifact: { type: "image", ref: "ghcr.io/acme/web:1.4.2" },
  env: [{ key: "DATABASE_URL", secretRef: "vault:generated/env_b12e04/postgres/db/connection-uri" }],
});

export const LB = mkNode("load_balancer/public", "load_balancer", {
  scheme: "internet-facing",
  tier: "public",
  listeners: [{ port: 443, protocol: "https" }],
  routes: [{ host: "app.customer.com", pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }],
});

export const DB = mkNode("postgres/db", "postgres", {
  engine: "postgres",
  version: "16",
  size: "small",
  highAvailability: false,
  backup: "daily",
  credentials: "generated",
  deletionPolicy: "deny",
  encryption: true,
  subnetTier: "private",
  zones: 1,
});

export const DNS = mkNode("dns_record/app.customer.com", "dns_record", { name: "app.customer.com", type: "alias", target: "load_balancer/public", zone: "customer.com" });
export const TLS = mkNode("tls_certificate/app.customer.com", "tls_certificate", { domain: "app.customer.com", validation: "dns_automatic" });
export const NET = mkNode("network/main", "network", { zones: 1 });
export const FW_PUBLIC = mkNode("firewall/internet-to-lb", "firewall", {
  direction: "ingress",
  protocol: "tcp",
  port: 443,
  source: { cidr: "0.0.0.0/0" },
  target: "load_balancer/public",
  capability: "public_http",
  description: "the public internet reaches the load balancer",
});
export const FW_LB_TO_WEB = mkNode("firewall/lb-to-web", "firewall", {
  direction: "ingress",
  protocol: "tcp",
  port: 8080,
  source: { address: "load_balancer/public" },
  target: "container_service/web",
  capability: "http",
  description: "the load balancer reaches web",
});
export const FW_WEB_TO_DB = mkNode("firewall/web-to-db", "firewall", {
  direction: "ingress",
  protocol: "tcp",
  port: 5432,
  source: { address: "container_service/web" },
  target: "postgres/db",
  capability: "postgres",
  description: "web reaches the database",
});
export const WORKER = mkNode("container_service/worker", "container_service", {
  workload: "worker",
  size: "small",
  vcpu: 0.25,
  memoryMb: 256,
  replicas: 1,
  zones: 1,
  subnetTier: "private",
  artifact: { type: "image", ref: "ghcr.io/acme/worker:2.0.0" },
  env: [],
});
export const FW_WEB_TO_WORKER = mkNode("firewall/web-to-worker", "firewall", {
  direction: "ingress",
  protocol: "tcp",
  port: 9000,
  source: { address: "container_service/web" },
  target: "container_service/worker",
  capability: "http",
  description: "web reaches worker",
});
export const SECRET = mkNode("secret/database-url-1a2b3c", "secret", { secretRef: "vault:generated/env_b12e04/postgres/db/connection-uri", store: "zenith_vault", purpose: "environment" });

/** A typical environment: web behind a load balancer, a worker, a managed database. */
export const TYPICAL_GRAPH: ResourceNode[] = [NET, WEB, WORKER, LB, DNS, TLS, DB, SECRET, FW_PUBLIC, FW_LB_TO_WEB, FW_WEB_TO_DB, FW_WEB_TO_WORKER];

/* ------------------------------- fake toolkit ------------------------------- */

const KB = {
  managedBy: OWNERSHIP.managedByLabel,
  partOf: OWNERSHIP.partOfLabel,
  name: OWNERSHIP.nameLabel,
};

const dnsName = (s: string) => s.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const leaf = (address: string) => address.slice(address.indexOf("/") + 1);

export interface Hostile {
  hostPath?: boolean;
  privileged?: boolean;
  hostNetwork?: boolean;
  serviceTypeLoadBalancer?: boolean;
  otherNamespace?: string;
  addCapability?: boolean;
  runAsRoot?: boolean;
  noSeccomp?: boolean;
}

export class FakeToolkit implements KubernetesToolkit {
  renderCalls: { nodes: ResourceNode[]; base: ToolkitRenderBase }[] = [];
  applyCalls: { objects: K8sObject[]; dryRun: boolean; environmentId?: string }[] = [];
  /** kinds the fake apply refuses, like the real apply refuses kinds absent from KIND_INFO */
  refuseKinds = new Set<string>();
  /** scripted results: applyResults[n] answers the nth apply call */
  failApplyAt: number | undefined;
  hostile: Hostile = {};
  store = new Map<string, Record<string, unknown>>();
  listUnavailable = false;
  listTruncated = false;
  readError: (Error & { code?: string }) | undefined;

  static key(ref: Pick<ObjectRef, "kind" | "namespace" | "name">): string {
    return `${ref.kind}|${ref.namespace ?? ""}|${ref.name}`;
  }

  put(obj: K8sObject | Record<string, unknown>): void {
    const o = obj as K8sObject;
    this.store.set(FakeToolkit.key({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name }), structuredClone(o) as Record<string, unknown>);
  }

  renderGraph(nodes: readonly ResourceNode[], base: ToolkitRenderBase) {
    this.renderCalls.push({ nodes: structuredClone([...nodes]) as ResourceNode[], base });
    const ns = this.hostile.otherNamespace ?? base.namespace ?? "default";
    const notes: string[] = [];
    const objects: K8sObject[] = [];
    const meta = (node: ResourceNode, name: string, namespace: string | undefined, labels: Record<string, string> = {}) => ({
      name,
      ...(namespace ? { namespace } : {}),
      labels: { [KB.managedBy]: "zenith", [KB.partOf]: base.environmentId, ...labels },
      annotations: { [OWNERSHIP.resourceAnnotation]: node.address, [OWNERSHIP.environmentAnnotation]: base.environmentId, [OWNERSHIP.specDigestAnnotation]: node.specDigest },
    });
    const h = this.hostile;
    const pod = (container: Record<string, unknown>): Record<string, unknown> => ({
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(h.hostNetwork ? { hostNetwork: true } : {}),
      securityContext: { runAsNonRoot: true, ...(h.noSeccomp ? {} : { seccompProfile: { type: "RuntimeDefault" } }), ...(h.runAsRoot ? { runAsUser: 0 } : {}) },
      containers: [
        {
          ...container,
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ["ALL"], ...(h.addCapability ? { add: ["NET_ADMIN"] } : {}) },
            ...(h.privileged ? { privileged: true } : {}),
          },
        },
      ],
      volumes: [{ name: "tmp", emptyDir: {} }, ...(h.hostPath ? [{ name: "host", hostPath: { path: "/" } }] : [])],
    });
    for (const node of [...nodes].sort((a, b) => (a.address < b.address ? -1 : 1))) {
      const name = dnsName(leaf(node.address));
      const spec = node.spec as Record<string, unknown>;
      switch (node.kind) {
        case "network":
        case "kubernetes_namespace":
          objects.push({ apiVersion: "v1", kind: "Namespace", metadata: meta(node, ns, undefined, { "pod-security.kubernetes.io/enforce": "baseline" }) });
          objects.push({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta(node, "zenith-default-deny-ingress", ns), spec: { podSelector: {}, policyTypes: ["Ingress"] } });
          break;
        case "container_service":
        case "static_site": {
          const selector = { [KB.name]: name, [KB.partOf]: base.environmentId };
          const image = spec.artifact && (spec.artifact as { type: string; ref?: string }).type === "image" ? (spec.artifact as { ref: string }).ref : base.resolveImage?.(node, spec.artifact as never);
          if (!image) throw new Error(`${node.address}: artifact has no image reference yet`);
          objects.push({
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: meta(node, name, ns, { [KB.name]: name }),
            spec: { replicas: spec.replicas ?? 1, selector: { matchLabels: selector }, template: { metadata: { labels: selector }, spec: pod({ name: "app", image }) } },
          });
          if (typeof spec.port === "number") {
            objects.push({
              apiVersion: "v1",
              kind: "Service",
              metadata: meta(node, name, ns),
              spec: { type: h.serviceTypeLoadBalancer ? "LoadBalancer" : "ClusterIP", selector, ports: [{ name: "http", port: spec.port, targetPort: "http" }] },
            });
          }
          break;
        }
        case "scheduled_job": {
          const selector = { [KB.name]: name, [KB.partOf]: base.environmentId };
          objects.push({
            apiVersion: "batch/v1",
            kind: "CronJob",
            metadata: meta(node, name, ns),
            spec: { schedule: "@daily", jobTemplate: { spec: { template: { metadata: { labels: selector }, spec: { ...pod({ name: "job", image: "ghcr.io/acme/job:1" }), restartPolicy: "Never" } } } } },
          });
          break;
        }
        case "load_balancer": {
          const routes = spec.routes as { host: string; pathPrefix: string; target: string; port?: number }[];
          const byHost = new Map<string, { path: string; service: string; port: number }[]>();
          for (const r of routes) {
            const list = byHost.get(r.host) ?? [];
            list.push({ path: r.pathPrefix, service: dnsName(leaf(r.target)), port: r.port ?? 80 });
            byHost.set(r.host, list);
          }
          objects.push({
            apiVersion: "networking.k8s.io/v1",
            kind: "Ingress",
            metadata: meta(node, name, ns),
            spec: {
              tls: [...byHost.keys()].sort().map((host) => ({ hosts: [host], secretName: `tls-${dnsName(host)}` })),
              rules: [...byHost.keys()].sort().map((host) => ({
                host,
                http: { paths: byHost.get(host)!.map((p) => ({ path: p.path, pathType: "Prefix", backend: { service: { name: p.service, port: { number: p.port } } } })) },
              })),
            },
          });
          break;
        }
        case "postgres":
        case "redis":
        case "mysql":
          // what the Kubernetes provider's dev tier does: the managed platform must never let this through
          objects.push({ apiVersion: "apps/v1", kind: "StatefulSet", metadata: meta(node, name, ns), spec: { replicas: 1, selector: { matchLabels: { [KB.name]: name } }, template: { spec: pod({ name: node.kind, image: `${node.kind}:16` }) } } });
          break;
        case "secret":
          objects.push({ apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { ...meta(node, `zs-${name}`, ns), annotations: { ...meta(node, "x", ns).annotations, [OWNERSHIP.secretRefAnnotation]: String(spec.secretRef) } } });
          break;
        case "identity":
          objects.push({ apiVersion: "v1", kind: "ServiceAccount", metadata: meta(node, name, ns), automountServiceAccountToken: false });
          break;
        case "volume":
          objects.push({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(node, name, ns), spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } });
          break;
        case "tls_certificate":
          objects.push({
            apiVersion: "cert-manager.io/v1",
            kind: "Certificate",
            metadata: meta(node, `cert-${dnsName(String(spec.domain))}`, ns),
            spec: { secretName: `tls-${dnsName(String(spec.domain))}`, dnsNames: [spec.domain], issuerRef: { name: base.clusterIssuers?.dns01 ?? "issuer", kind: "ClusterIssuer" } },
          });
          break;
        case "firewall": {
          const source = spec.source as { cidr?: string; address?: string };
          const target = nodes.find((n) => n.address === spec.target);
          if (!target) throw new Error(`${node.address}: firewall target ${String(spec.target)} is not in the graph`);
          const peers = source.cidr ? [{ ipBlock: { cidr: source.cidr } }] : [{ podSelector: { matchLabels: { [KB.name]: dnsName(leaf(String(source.address))), [KB.partOf]: base.environmentId } } }];
          objects.push({
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: meta(node, `fw-${dnsName(leaf(node.address))}`, ns),
            spec: { podSelector: { matchLabels: { [KB.name]: dnsName(leaf(String(spec.target))) } }, policyTypes: ["Ingress"], ingress: [{ from: peers, ports: [{ protocol: "TCP", port: spec.port }] }] },
          });
          break;
        }
        default:
          throw new Error(`fake renderer: ${node.kind} is not modelled`);
      }
    }
    return { objects, notes };
  }

  async apply(objects: readonly K8sObject[], _session: KubernetesSession, opts: ToolkitApplyOptions): Promise<ToolkitApplyReport> {
    const call = { objects: structuredClone([...objects]) as K8sObject[], dryRun: opts.dryRun === true, environmentId: opts.environmentId };
    this.applyCalls.push(call);
    const index = this.applyCalls.length - 1;
    const refs = objects.map((o) => ({ apiVersion: o.apiVersion, kind: o.kind, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), name: o.metadata.name }));
    const refused = objects.find((o) => this.refuseKinds.has(o.kind));
    if (refused) {
      return { ok: false, dryRun: call.dryRun, refused: true, results: refs.map((ref) => ({ ref, status: ref.kind === refused.kind ? "error" : "skipped", message: `Zenith does not apply ${refused.apiVersion} ${refused.kind}.`, errorCode: "invalid_object" })) };
    }
    if (this.failApplyAt === index) {
      return { ok: false, dryRun: call.dryRun, refused: true, results: refs.map((ref) => ({ ref, status: "ownership_conflict", message: "exists and is not managed by Zenith", errorCode: "ownership_conflict" })) };
    }
    // the real apply resolves every Secret's reference; do the same so dry-run behavior is visible
    for (const o of objects) {
      const ref = o.metadata.annotations?.[OWNERSHIP.secretRefAnnotation];
      if (o.kind === "Secret" && typeof ref === "string") {
        const v = await opts.resolveSecret?.(ref);
        if (v === null || v === undefined) {
          return { ok: false, dryRun: call.dryRun, refused: true, results: refs.map((r) => ({ ref: r, status: "error", message: `Secret reference ${ref} could not be resolved.`, errorCode: "secret_unresolved" })) };
        }
      }
    }
    if (!call.dryRun) for (const o of objects) this.put(o);
    return { ok: true, dryRun: call.dryRun, refused: false, results: refs.map((ref) => ({ ref, status: "created" })) };
  }

  async read(_session: KubernetesSession, ref: ObjectRef): Promise<Record<string, unknown> | undefined> {
    if (this.readError) throw this.readError;
    return this.store.get(FakeToolkit.key(ref));
  }

  async list(_session: KubernetesSession, query: ToolkitListQuery): Promise<ToolkitListResult> {
    if (this.listUnavailable) return { items: [], truncated: false, unavailable: true };
    if (this.readError) throw this.readError;
    const [k, v] = (query.labelSelector ?? "").split("=");
    const items = [...this.store.values()].filter((o) => {
      const x = o as unknown as K8sObject;
      if (x.kind !== query.kind) return false;
      if (query.namespace !== undefined && x.metadata.namespace !== query.namespace) return false;
      return !k || x.metadata.labels?.[k] === v;
    });
    return { items: structuredClone(items), truncated: this.listTruncated, unavailable: false };
  }
}

/* --------------------------------- sessions -------------------------------- */

export const K8S_SESSION: KubernetesSession = {
  provider: "kubernetes",
  server: "https://k8s.managed.example.com:6443",
  expiresAt: "2099-01-01T00:00:00.000Z",
  kubeConfig: () => {
    throw new Error("the fake session has no kubeconfig");
  },
};

export class MemorySink implements ConnectionSecretSink {
  values = new Map<string, string>();
  failPut = false;
  async put(ref: string, value: string): Promise<void> {
    if (this.failPut) throw new Error(`vault write failed for ${value}`); // echoes the value, like a careless store
    this.values.set(ref, value);
  }
  async exists(ref: string): Promise<boolean> {
    return this.values.has(ref);
  }
}

export function session(databases: ManagedDatabaseProvider, over: Partial<ZenithSession> = {}, env: ZenithEnv = FULL_ENV): ZenithSession {
  return {
    provider: "zenith",
    tenant: TENANT,
    substrate: substrate(env),
    kubernetes: K8S_SESSION,
    databases,
    expiresAt: K8S_SESSION.expiresAt,
    toJSON: () => ({}),
    ...over,
  };
}

export function driverCtx(s: ZenithSession, over: Partial<DriverContext<ZenithSession>> = {}): DriverContext<ZenithSession> {
  return {
    provider: "zenith",
    region: "zenith-managed",
    workspaceId: TENANT.workspaceId,
    environmentId: TENANT.environmentId,
    session: s,
    signal: new AbortController().signal,
    log: () => {},
    tags: {},
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    ...over,
  };
}

/* -------------------------------- fake neon -------------------------------- */

export const NEON_KEY = "neon_api_key_CANARY_9f8e7d6c5b4a";
export const DB_PASSWORD = "pw-CANARY-s3cr3t-0a1b2c3d4e5f";

interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
  created_at: string;
  deleted_at?: string;
  history_retention_seconds: number;
  store_passwords: boolean;
  provisioner: string;
  org_id?: string;
}

export interface NeonRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body?: unknown;
}

export class FakeNeon {
  projects = new Map<string, NeonProject>();
  endpointState: "init" | "active" | "idle" | "none" | "disabled" = "active";
  requests: NeonRequest[] = [];
  /** scripted failures: `${METHOD} ${pathPrefix}` → { status, body, headers } used once per entry */
  failures: { match: string; status: number; body?: unknown; raw?: string; headers?: Record<string, string>; times: number }[] = [];
  redirectTo: string | undefined;
  server: http.Server | undefined;
  url = "";
  private seq = 0;
  /** make list return at most this many per page, with cursors */
  pageSize = 100;
  uriCanBeMissingFromCreate = false;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api/v2`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  seed(name: string, over: Partial<NeonProject> = {}): NeonProject {
    const id = `proj-seed-${++this.seq}`;
    const p: NeonProject = { id, name, region_id: "aws-us-east-2", pg_version: 16, created_at: "2026-09-01T00:00:00Z", history_retention_seconds: 86400, store_passwords: true, provisioner: "k8s-neonvm", ...over };
    this.projects.set(id, p);
    return p;
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private connectionUri(): string {
    return `postgresql://app_owner:${DB_PASSWORD}@ep-quiet-glade-123456.us-east-2.aws.neon.tech/app?sslmode=require`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/api\/v2/, "");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    this.requests.push({ method: req.method ?? "", path, query: url.searchParams, auth: req.headers.authorization, body });
    const idx = this.failures.findIndex((f) => `${req.method} ${path}`.startsWith(f.match) && f.times > 0);
    if (idx !== -1) {
      const f = this.failures[idx];
      f.times -= 1;
      if (f.raw !== undefined) {
        res.writeHead(f.status, { "content-type": "text/html", ...(f.headers ?? {}) });
        return void res.end(f.raw);
      }
      return this.send(res, f.status, f.body ?? { request_id: "req-fail", code: "", message: `scripted ${f.status}` }, f.headers);
    }
    if (this.redirectTo) {
      res.writeHead(302, { location: this.redirectTo });
      return void res.end();
    }
    if (req.headers.authorization !== `Bearer ${NEON_KEY}`) return this.send(res, 401, { request_id: "req-401", code: "", message: "authorization failed" });

    if (req.method === "GET" && path === "/projects") {
      const search = url.searchParams.get("search") ?? "";
      const all = [...this.projects.values()].filter((p) => !p.deleted_at && (p.name.includes(search) || p.id.includes(search))).sort((a, b) => (a.id < b.id ? -1 : 1));
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? all.findIndex((p) => p.id === cursor) + 1 : 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), this.pageSize);
      const page = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return this.send(res, 200, { projects: page, ...(more ? { pagination: { cursor: page[page.length - 1].id } } : {}) });
    }
    if (req.method === "POST" && path === "/projects") {
      const p = (body as { project?: Record<string, unknown> } | undefined)?.project;
      if (!p || typeof p.name !== "string") return this.send(res, 400, { request_id: "req-400", code: "", message: "project.name is required" });
      if (typeof p.pg_version === "number" && (p.pg_version < 14 || p.pg_version > 19)) return this.send(res, 400, { request_id: "req-400", code: "", message: "unsupported pg_version" });
      const project: NeonProject = {
        id: `proj-${++this.seq}-${Math.abs(p.name.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000}`,
        name: p.name,
        region_id: String(p.region_id),
        pg_version: Number(p.pg_version ?? 17),
        created_at: "2026-09-30T00:00:00Z",
        history_retention_seconds: 86400,
        store_passwords: p.store_passwords === true,
        provisioner: "k8s-neonvm",
        ...(typeof p.org_id === "string" ? { org_id: p.org_id } : {}),
      };
      this.projects.set(project.id, project);
      return this.send(res, 201, {
        project,
        ...(this.uriCanBeMissingFromCreate ? {} : { connection_uris: [{ connection_uri: this.connectionUri(), connection_parameters: { database: "app", password: DB_PASSWORD, role: "app_owner", host: "ep-quiet-glade-123456.us-east-2.aws.neon.tech", pooler_host: "ep-quiet-glade-123456-pooler.us-east-2.aws.neon.tech" } }] }),
        roles: [{ branch_id: "br-1", name: "app_owner", password: DB_PASSWORD }],
        databases: [{ id: 1, name: "app", owner_name: "app_owner" }],
        operations: [],
        branch: { id: "br-1", name: "main" },
        endpoints: [{ id: "ep-1", host: "ep-quiet-glade-123456.us-east-2.aws.neon.tech", current_state: "init" }],
      });
    }
    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const p = this.projects.get(m[1]);
      const sub = m[2] ?? "";
      if (!p || (p.deleted_at && sub === "")) return this.send(res, 404, { request_id: "req-404", code: "", message: "project not found" });
      if (req.method === "GET" && sub === "") return this.send(res, 200, { project: p });
      if (req.method === "DELETE" && sub === "") {
        p.deleted_at = "2026-09-30T01:00:00Z";
        return this.send(res, 200, { project: p });
      }
      if (req.method === "GET" && sub === "/connection_uri") return this.send(res, 200, { uri: this.connectionUri() });
      if (req.method === "GET" && sub === "/endpoints") {
        const eps = this.endpointState === "none" ? [] : [{ id: "ep-1", host: "ep-quiet-glade-123456.us-east-2.aws.neon.tech", current_state: this.endpointState === "disabled" ? "active" : this.endpointState, disabled: this.endpointState === "disabled" }];
        return this.send(res, 200, { endpoints: eps });
      }
    }
    return this.send(res, 404, { request_id: "req-404", code: "", message: "not found" });
  }
}

/** Resolver that knows exactly one vault reference. */
export function resolver(ref: string, value: string | undefined): (r: string) => Promise<string | undefined> {
  return async (r) => (r === ref ? value : undefined);
}
