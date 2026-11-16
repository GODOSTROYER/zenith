/**
 * Hand-built fixtures for the incident engine tests.
 *
 * The graph mirrors what `expandManifest()` produces for a small app (same
 * address shapes, spec shapes and edge relations):
 *
 *   dns_record/app.example.com ──resolves_to──▶ load_balancer/public
 *   tls_certificate/app.example.com ──secures──▶ load_balancer/public
 *   firewall/internet-to-lb-{80,443} ──secures──▶ load_balancer/public
 *   load_balancer/public ──routes_to──▶ container_service/web
 *   firewall/lb-to-web ──secures──▶ container_service/web
 *   container_service/web ──connects_to sql:5432──▶ postgres/db
 *   firewall/web-to-db ──secures──▶ postgres/db
 *   container_service/web ──reads_secret DATABASE_URL──▶ secret/DATABASE_URL-abc123
 *   identity/web (workload container_service/web)
 *
 * Everything the ports return is data here: nothing is real, every evidence
 * record built from it is a test artefact.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import type { EventQuery, LogQuery, MetricQuery, MetricSeries, NormalizedEvent, NormalizedLog, QueryResult } from "@/lib/observability/types";
import type { PolicyDecision } from "@/lib/policy/types";
import type { DriftFinding, DriftReport, Observation, ObservedValue, PortableKind, ResourceEdge, ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import type { HttpProbeResult, InvestigationPorts, RecentChange } from "@/lib/incidents";

export const WORKSPACE = "ws_acme";
export const PROJECT = "proj_shop";
export const ENV = "env_prod";
export const NOW = new Date("2026-09-30T12:00:00.000Z");

export const ADDR = {
  dns: "dns_record/app.example.com",
  tls: "tls_certificate/app.example.com",
  fw80: "firewall/internet-to-lb-80",
  fw443: "firewall/internet-to-lb-443",
  lb: "load_balancer/public",
  fwLbWeb: "firewall/lb-to-web",
  web: "container_service/web",
  fwWebDb: "firewall/web-to-db",
  db: "postgres/db",
  secret: "secret/DATABASE_URL-abc123",
  identity: "identity/web",
} as const;

/* --------------------------------- the graph -------------------------------- */

export function node(address: string, kind: PortableKind, spec: Record<string, unknown>, extra: Partial<ResourceNode> = {}): ResourceNode {
  return {
    address,
    kind,
    provider: "aws",
    region: "us-east-1",
    nativeType: `aws:${kind}`,
    ownership: "managed",
    spec,
    origin: [],
    dependsOn: [],
    specDigest: `digest-${address}`,
    labels: { "zenith:environment": ENV, "zenith:managed": "true", "zenith:resource": address },
    ...extra,
  };
}

const edge = (from: string, to: string, relation: ResourceEdge["relation"], detail?: string): ResourceEdge => ({ from, to, relation, ...(detail ? { detail } : {}) });

export function buildGraph(): ResourceGraph {
  const nodes: ResourceNode[] = [
    node(ADDR.dns, "dns_record", { name: "app.example.com", type: "alias", target: ADDR.lb, zone: "dns_zone/example.com" }),
    node(ADDR.tls, "tls_certificate", { domain: "app.example.com", validation: "dns_automatic", zone: "dns_zone/example.com" }),
    node(ADDR.fw80, "firewall", { direction: "ingress", protocol: "tcp", port: 80, source: { cidr: "0.0.0.0/0" }, target: ADDR.lb, capability: "public_http", description: "the public internet reaches the load balancer on tcp/80" }),
    node(ADDR.fw443, "firewall", { direction: "ingress", protocol: "tcp", port: 443, source: { cidr: "0.0.0.0/0" }, target: ADDR.lb, capability: "public_http", description: "the public internet reaches the load balancer on tcp/443" }),
    node(ADDR.lb, "load_balancer", {
      scheme: "internet-facing",
      tier: "public",
      listeners: [
        { port: 80, protocol: "http", redirectToHttps: true },
        { port: 443, protocol: "https" },
      ],
      routes: [{ host: "app.example.com", pathPrefix: "/", tls: true, target: ADDR.web, port: 3000, healthPath: "/health" }],
    }),
    node(ADDR.fwLbWeb, "firewall", { direction: "ingress", protocol: "tcp", port: 3000, source: { address: ADDR.lb }, target: ADDR.web, capability: "http", description: "the load balancer reaches web on tcp/3000" }),
    node(ADDR.web, "container_service", {
      workload: "web",
      size: "small",
      vcpu: 0.5,
      memoryMb: 1024,
      replicas: 2,
      port: 3000,
      healthPath: "/health",
      artifact: { type: "image", ref: "registry.example.com/shop/web:1.4.2" },
      env: [
        { key: "PORT", value: "3000" },
        { key: "DATABASE_URL", secretRef: "vault:db-url" },
      ],
      zones: 2,
      subnetTier: "private",
    }),
    node(ADDR.fwWebDb, "firewall", { direction: "ingress", protocol: "tcp", port: 5432, source: { address: ADDR.web }, target: ADDR.db, capability: "sql", description: "web reaches db (sql) on tcp/5432" }),
    node(ADDR.db, "postgres", { size: "small", engine: "postgres", version: "16", highAvailability: false, backup: "daily", credentials: "generated", subnetTier: "private", zones: 2, deletionPolicy: "deny", encryption: true }),
    node(ADDR.secret, "secret", { secretRef: "vault:db-url", store: "zenith_vault", purpose: "environment" }),
    node(ADDR.identity, "identity", { principal: "workload", workload: ADDR.web, grants: [{ target: ADDR.secret, access: ["read"], via: ["env:DATABASE_URL"] }] }),
  ];
  const edges: ResourceEdge[] = [
    edge(ADDR.dns, ADDR.lb, "resolves_to"),
    edge(ADDR.tls, ADDR.lb, "secures"),
    edge(ADDR.fw80, ADDR.lb, "secures", "tcp/80"),
    edge(ADDR.fw443, ADDR.lb, "secures", "tcp/443"),
    edge(ADDR.lb, ADDR.web, "routes_to", "app.example.com/"),
    edge(ADDR.fwLbWeb, ADDR.web, "secures", "tcp/3000"),
    edge(ADDR.web, ADDR.db, "connects_to", "sql:5432"),
    edge(ADDR.fwWebDb, ADDR.db, "secures", "tcp/5432"),
    edge(ADDR.web, ADDR.secret, "reads_secret", "DATABASE_URL"),
  ];
  return { version: 1, environmentId: ENV, manifestDigest: "m-digest", nodes, edges, graphDigest: "g-digest", notes: [] };
}

/** a second postgres, a redis and its firewall, for multi-dependency tests */
export function withCache(graph: ResourceGraph): ResourceGraph {
  const cache = node("redis/cache", "redis", { size: "small", engine: "redis", highAvailability: false, backup: "none", subnetTier: "private", zones: 2, deletionPolicy: "deny", encryption: true });
  const fw = node("firewall/web-to-cache", "firewall", { direction: "ingress", protocol: "tcp", port: 6379, source: { address: ADDR.web }, target: "redis/cache", capability: "cache", description: "web reaches cache (cache) on tcp/6379" });
  return {
    ...graph,
    nodes: [...graph.nodes, cache, fw],
    edges: [...graph.edges, edge(ADDR.web, "redis/cache", "connects_to", "cache:6379"), edge("firewall/web-to-cache", "redis/cache", "secures", "tcp/6379")],
  };
}

/* ---------------------------------- builders -------------------------------- */

const known = (value: unknown): ObservedValue => ({ state: "known", value, observedAt: NOW.toISOString() });

export function obs(address: string, presence: Observation["presence"], attrs: Record<string, unknown> = {}, extra: Partial<Observation> = {}): Observation {
  return {
    address,
    presence,
    attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, known(v)])),
    observedAt: NOW.toISOString(),
    source: "test.driver@1",
    simulated: false,
    ...extra,
  };
}

export function rt(address: string, health: RuntimeState["health"], counts: Record<string, number> = {}, signals: string[] = [], extra: Partial<RuntimeState> = {}): RuntimeState {
  return { address, health, counts, signals, observedAt: NOW.toISOString(), source: "test.runtime@1", simulated: false, ...extra };
}

export function log(address: string, message: string, minutesAgo = 5, severity: NormalizedLog["severity"] = "error", extra: Partial<NormalizedLog> = {}): NormalizedLog {
  return {
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    address,
    provider: "aws",
    environmentId: ENV,
    severity,
    message,
    attributes: {},
    native: {},
    ...extra,
  };
}

export function series(metric: string, values: number[], unit: string, address?: string): MetricSeries {
  return {
    metric,
    unit,
    address,
    provider: "aws",
    native: {},
    points: values.map((value, i) => ({ timestamp: new Date(NOW.getTime() - (values.length - i) * 60_000).toISOString(), value })),
  };
}

export function driftReport(findings: DriftFinding[], extra: Partial<DriftReport> = {}): DriftReport {
  return { environmentId: ENV, graphDigest: "g-digest", computedAt: NOW.toISOString(), findings, unobserved: [], simulated: false, ...extra };
}

export function driftFinding(address: string, cls: DriftFinding["class"], extra: Partial<DriftFinding> = {}): DriftFinding {
  return { address, class: cls, severity: "medium", repairable: true, autoRepairEligible: true, explanation: `${address} is ${cls} versus the desired graph.`, ...extra };
}

export const change = (kind: string, minutesAgo: number, summary: string, operationId?: string): RecentChange => ({
  at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  kind,
  summary,
  ...(operationId ? { operationId } : {}),
});

/* ----------------------------------- world ---------------------------------- */

type Answer<T> = T | Error | "hang";

export interface World {
  observations: Record<string, Answer<Observation>>;
  runtimes: Record<string, Answer<RuntimeState>>;
  expected: Record<string, Answer<Record<string, unknown>>>;
  logs: Record<string, Answer<NormalizedLog[]>>;
  logUnavailable: { source: string; reason: string }[];
  events: Record<string, Answer<NormalizedEvent[]>> | undefined;
  metrics: Record<string, Answer<MetricSeries[]>>;
  changes: Answer<RecentChange[]>;
  drift: Answer<DriftReport | null>;
  http: Record<string, Answer<HttpProbeResult>> | undefined;
  policy: (req: CapabilityRequest) => PolicyDecision | Promise<PolicyDecision> | Error;
  /** artificial latency per call, ms (0 = immediate) */
  latency: (kind: string, key: string) => number;
  simulated: boolean;
}

export interface Calls {
  observe: string[];
  runtime: string[];
  searchLogs: LogQuery[];
  queryMetrics: MetricQuery[];
  searchEvents: EventQuery[];
  httpProbe: string[];
  policy: CapabilityRequest[];
  maxInFlight: number;
}

const allow = (): PolicyDecision => ({ outcome: "allow", reasons: [{ code: "auto_remediation_allowed", message: "allowed" }] });
export const requireApproval = (): PolicyDecision => ({ outcome: "require_approval", reasons: [{ code: "production_mutation", message: "needs approval" }], approval: { count: 1, minRole: "editor", separationOfDuties: false } });
export const deny = (): PolicyDecision => ({ outcome: "deny", reasons: [{ code: "capability_denied", message: "denied" }] });

/** A fully healthy environment for the default graph. */
export function healthyWorld(): World {
  const lbTarget = "lb-123.us-east-1.elb.amazonaws.com";
  const fwAttrs = (port: number) => ({ port, protocol: "tcp" });
  return {
    observations: {
      [ADDR.dns]: obs(ADDR.dns, "present", { target: lbTarget, type: "A" }),
      [ADDR.tls]: obs(ADDR.tls, "present", { status: "ISSUED", notAfter: new Date(NOW.getTime() + 90 * 86_400_000).toISOString() }),
      [ADDR.fw80]: obs(ADDR.fw80, "present", fwAttrs(80)),
      [ADDR.fw443]: obs(ADDR.fw443, "present", fwAttrs(443)),
      [ADDR.lb]: obs(ADDR.lb, "present", { listeners: [80, 443] }),
      [ADDR.fwLbWeb]: obs(ADDR.fwLbWeb, "present", fwAttrs(3000)),
      [ADDR.fwWebDb]: obs(ADDR.fwWebDb, "present", fwAttrs(5432)),
      [ADDR.db]: obs(ADDR.db, "present", { engine: "postgres" }),
      [ADDR.secret]: obs(ADDR.secret, "present"),
      [ADDR.identity]: obs(ADDR.identity, "present"),
    },
    runtimes: {
      [ADDR.lb]: rt(ADDR.lb, "healthy", { target_groups: 1, targets_healthy: 2, targets_unhealthy: 0 }),
      [ADDR.web]: rt(ADDR.web, "healthy", { desired: 2, running: 2, pending: 0, targets_healthy: 2, targets_unhealthy: 0 }),
      [ADDR.db]: rt(ADDR.db, "healthy", {}, ["db_status:available"]),
    },
    expected: {
      [ADDR.dns]: { target: lbTarget, type: "A" },
      [ADDR.fw80]: fwAttrs(80),
      [ADDR.fw443]: fwAttrs(443),
      [ADDR.fwLbWeb]: fwAttrs(3000),
      [ADDR.fwWebDb]: fwAttrs(5432),
    },
    logs: {
      [ADDR.web]: [
        log(ADDR.web, "listening on port 3000", 25, "info"),
        log(ADDR.web, "GET /health 200 2ms", 4, "info"),
        log(ADDR.web, "GET /products 200 31ms", 3, "info"),
        log(ADDR.web, "connected to database", 24, "info"),
      ],
    },
    logUnavailable: [],
    events: undefined,
    metrics: {
      [ADDR.lb]: [series("http.5xx.rate", [0, 0, 0, 0, 0, 0], "count/min", ADDR.lb)],
      [ADDR.web]: [series("cpu.utilization", [31, 29, 34, 30, 28], "percent", ADDR.web), series("memory.utilization", [52, 53, 52, 54, 53], "percent", ADDR.web)],
    },
    changes: [],
    drift: driftReport([]),
    http: undefined,
    policy: allow,
    latency: () => 0,
    simulated: false,
  };
}

/* ------------------------------- port construction --------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

export function makePorts(world: World, calls?: Calls, opts: { newId?: () => string } = {}): InvestigationPorts {
  const c: Calls = calls ?? { observe: [], runtime: [], searchLogs: [], queryMetrics: [], searchEvents: [], httpProbe: [], policy: [], maxInFlight: 0 };
  let inFlight = 0;
  const track = async <T>(kind: string, key: string, run: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    c.maxInFlight = Math.max(c.maxInFlight, inFlight);
    try {
      const ms = world.latency(kind, key);
      if (ms > 0) await sleep(ms);
      return await run();
    } finally {
      inFlight -= 1;
    }
  };
  const resolve = async <T>(a: Answer<T> | undefined, fallback: () => T): Promise<T> => {
    if (a === "hang") return never();
    if (a instanceof Error) throw a;
    return a === undefined ? fallback() : a;
  };
  const result = <T>(items: T[], extra: Partial<QueryResult<T>> = {}): QueryResult<T> => ({ items, sources: ["test.source"], truncated: false, simulated: world.simulated, unavailable: [], ...extra });

  const ports: InvestigationPorts = {
    observe: (address) => {
      c.observe.push(address);
      return track("observe", address, () => resolve(world.observations[address], () => obs(address, "unknown", {}, { error: "not configured in test world" })));
    },
    runtime: (address) => {
      c.runtime.push(address);
      return track("runtime", address, () => resolve(world.runtimes[address], () => rt(address, "unknown", {}, ["counts_not_read"])));
    },
    expected: (address) => resolve(world.expected[address], () => ({})),
    searchLogs: (q) => {
      c.searchLogs.push(q);
      const address = q.scope.addresses?.[0] ?? "";
      return track("logs", address, async () => {
        const items = await resolve(world.logs[address], () => []);
        return result(items, { unavailable: world.logUnavailable });
      });
    },
    queryMetrics: (q) => {
      c.queryMetrics.push(q);
      const address = q.scope.addresses?.[0] ?? "";
      return track("metrics", address, async () => {
        const items = await resolve(world.metrics[address], () => []);
        return result(items.filter((s) => q.metrics.includes(s.metric)));
      });
    },
    recentChanges: () => track("changes", "", () => resolve(world.changes, () => [])),
    drift: () => track("drift", "", () => resolve(world.drift, () => null)),
    policyDryRun: async (req) => {
      c.policy.push(req);
      const r = world.policy(req);
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => NOW,
    ...(opts.newId ? { newId: opts.newId } : { newId: () => "inv_test" }),
  };
  if (world.events) {
    const events = world.events;
    ports.searchEvents = (q) => {
      c.searchEvents.push(q);
      const address = q.scope.addresses?.[0] ?? "";
      return track("events", address, async () => result(await resolve(events[address], () => [])));
    };
  }
  if (world.http) {
    const http = world.http;
    ports.httpProbe = (url) => {
      c.httpProbe.push(url);
      const host = new URL(url).hostname;
      return track("http", host, () => resolve(http[host], () => ({ status: 200, latencyMs: 40 })));
    };
  }
  return ports;
}

export function newCalls(): Calls {
  return { observe: [], runtime: [], searchLogs: [], queryMetrics: [], searchEvents: [], httpProbe: [], policy: [], maxInFlight: 0 };
}

/* ------------------------------- break scenarios ---------------------------- */

/** The acceptance scenario: the web→db ingress rule was removed out of band. */
export function removeDbIngress(w: World, opts: { withDrift?: boolean; withMetrics?: boolean } = {}): World {
  w.observations[ADDR.fwWebDb] = obs(ADDR.fwWebDb, "missing");
  w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { target_groups: 1, targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2", "target_reason:Target.FailedHealthChecks:2"]);
  w.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 2, pending: 0 }, []);
  w.logs[ADDR.web] = [
    log(ADDR.web, "listening on port 3000", 25, "info"),
    log(ADDR.web, "Error: connect ETIMEDOUT 10.0.3.15:5432", 6),
    log(ADDR.web, "Error: connect ETIMEDOUT 10.0.3.15:5432", 4),
    log(ADDR.web, "Error: connect ETIMEDOUT 10.0.3.15:5432", 2),
    log(ADDR.web, "GET /health 503 3ms", 1, "warn"),
  ];
  if (opts.withDrift !== false) w.drift = driftReport([driftFinding(ADDR.fwWebDb, "missing", { explanation: "firewall/web-to-db is in the desired graph but the provider reports it missing." })]);
  if (opts.withMetrics !== false) w.metrics[ADDR.lb] = [series("http.5xx.rate", [0, 0, 4, 9, 12, 14], "count/min", ADDR.lb)];
  return w;
}
