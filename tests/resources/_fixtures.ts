/**
 * Shared fixtures for the resource-model tests. Underscore-prefixed so vitest
 * does not treat it as a test file.
 */
import fs from "node:fs";
import path from "node:path";
import type { Binding, Manifest, Resource, Route, Service } from "@/lib/domain/types";
import { blueprints } from "@/lib/blueprints";
import { importCompose } from "@/lib/importers/compose";
import { importDockerfile } from "@/lib/importers/dockerfile";
import { importTerraform } from "@/lib/importers/terraform";
import { canonical } from "@/lib/controlplane/digest";
import type { ExpandEnv } from "@/lib/resources";
import type { ResourceGraph } from "@/lib/resources";

export const PROD: ExpandEnv = {
  id: "env-prod",
  name: "production",
  class: "production",
  provider: "aws",
  region: "us-east-1",
  baseDomain: "atlas.zenith.test",
};

export const STAGING: ExpandEnv = { ...PROD, id: "env-stg", name: "staging", class: "staging" };

export const svc = (over: Partial<Service> & Pick<Service, "id" | "name" | "kind">): Service => ({
  source: { type: "image", image: "ghcr.io/acme/app:1" },
  size: "small",
  replicas: 1,
  env: [],
  ownership: "managed",
  ...over,
});

export const res = (over: Partial<Resource> & Pick<Resource, "id" | "name" | "kind">): Resource => ({
  config: {},
  size: "small",
  ownership: "managed",
  ...over,
});

export const route = (over: Partial<Route> & Pick<Route, "id" | "host">): Route => ({
  pathPrefix: "/",
  tls: true,
  managedDns: true,
  ...over,
});

export const bind = (id: string, from: string, to: string, capability: Binding["capability"]): Binding => ({ id, from, to, capability });

export const manifest = (parts: Partial<Omit<Manifest, "version">>): Manifest => ({
  version: 1,
  services: [],
  resources: [],
  routes: [],
  bindings: [],
  ...parts,
});

/** web + postgres + tls route: the smallest interesting system. */
export function webDb(): Manifest {
  return manifest({
    services: [svc({ id: "svc-web", name: "web", kind: "web", port: 3000, healthPath: "/healthz", replicas: 2 })],
    resources: [res({ id: "res-db", name: "postgres", kind: "postgres", size: "standard" })],
    routes: [route({ id: "rt-app", host: "app.atlas.zenith.test" })],
    bindings: [bind("b-route", "rt-app", "svc-web", "http"), bind("b-sql", "svc-web", "res-db", "sql")],
  });
}

/** Every branch expansion has: managed + referenced + external, secrets, static, cron, git, queue, blob. */
export function fullManifest(): Manifest {
  return manifest({
    services: [
      svc({
        id: "svc-api",
        name: "api",
        kind: "web",
        source: { type: "git", repo: "github.com/acme/api", ref: "main", dockerfile: "Dockerfile" },
        size: "standard",
        replicas: 2,
        port: 8080,
        healthPath: "/health",
        env: [
          { key: "LOG_LEVEL", value: "info" },
          { key: "SESSION_SECRET", secretRef: "vault:proj/svc-api/SESSION_SECRET" },
          { key: "STRIPE_KEY", secretRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe" },
        ],
      }),
      svc({ id: "svc-worker", name: "worker", kind: "worker", env: [{ key: "SESSION_SECRET", secretRef: "vault:proj/svc-api/SESSION_SECRET" }] }),
      svc({ id: "svc-nightly", name: "nightly", kind: "cron", schedule: "0 3 * * *" }),
      svc({ id: "svc-site", name: "site", kind: "static", source: { type: "git", repo: "github.com/acme/site", ref: "main" } }),
      svc({ id: "svc-legacy", name: "legacy", kind: "web", port: 9000, ownership: "referenced" }),
    ],
    resources: [
      res({ id: "res-db", name: "db", kind: "postgres", size: "standard", config: { version: "15" } }),
      res({ id: "res-cache", name: "cache", kind: "redis" }),
      res({ id: "res-assets", name: "assets", kind: "object_store" }),
      res({ id: "res-jobs", name: "jobs", kind: "queue", config: { visibilityTimeout: 60 } }),
      res({ id: "res-mail", name: "mail", kind: "email" }),
      res({ id: "res-old-db", name: "old-db", kind: "postgres", ownership: "referenced", externalRef: "legacy.abc.us-east-1.rds.amazonaws.com" }),
      res({ id: "res-stripe", name: "stripe", kind: "queue", ownership: "external" }),
    ],
    routes: [
      route({ id: "rt-app", host: "app.acme.io" }),
      route({ id: "rt-www", host: "www.acme.io" }),
      route({ id: "rt-plain", host: "plain.atlas.zenith.test", tls: false }),
      route({ id: "rt-self", host: "self.acme.io", managedDns: false }),
    ],
    bindings: [
      bind("b1", "rt-app", "svc-api", "http"),
      bind("b2", "rt-www", "svc-site", "http"),
      bind("b3", "rt-plain", "svc-api", "http"),
      bind("b4", "rt-self", "svc-api", "http"),
      bind("b5", "svc-api", "res-db", "sql"),
      bind("b6", "svc-api", "res-cache", "cache"),
      bind("b7", "svc-api", "res-assets", "blob"),
      bind("b8", "svc-api", "res-jobs", "queue_publish"),
      bind("b9", "svc-worker", "res-jobs", "queue_consume"),
      bind("b10", "svc-worker", "res-db", "sql"),
      bind("b11", "svc-nightly", "res-db", "sql"),
      bind("b12", "svc-api", "res-mail", "smtp"),
      bind("b13", "svc-api", "res-old-db", "sql"),
      bind("b14", "svc-site", "svc-api", "http"),
      bind("b15", "svc-worker", "svc-api", "http"),
    ],
  });
}

/* --------------------------- V1 population -------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random V1 manifests, including optional keys explicitly set to `undefined`. */
export function randomManifests(count: number, seed = 1): Manifest[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const out: Manifest[] = [];
  for (let n = 0; n < count; n++) {
    const services: Service[] = [];
    const resources: Resource[] = [];
    const nSvc = Math.floor(rnd() * 5);
    const nRes = Math.floor(rnd() * 5);
    for (let i = 0; i < nSvc; i++) {
      const kind = pick(["web", "worker", "cron", "static"] as const);
      services.push(
        svc({
          id: `s${n}-${i}`,
          name: `svc-${i}`,
          kind,
          size: pick(["nano", "small", "standard", "performance"] as const),
          replicas: Math.floor(rnd() * 4),
          port: rnd() < 0.6 ? 3000 + i : undefined,
          healthPath: rnd() < 0.4 ? "/h" : undefined,
          schedule: kind === "cron" ? "*/5 * * * *" : undefined,
          source: pick([
            { type: "image", image: "nginx:1" },
            { type: "git", repo: "github.com/a/b", ref: "main" },
            { type: "blueprint", blueprint: "web" },
          ] as const) as Service["source"],
          env: rnd() < 0.5 ? [{ key: "A", value: "1" }, { key: "PASSWORD", secretRef: `vault:p/${i}/PASSWORD` }] : [],
          ownership: rnd() < 0.15 ? pick(["referenced", "external"] as const) : "managed",
        })
      );
    }
    for (let i = 0; i < nRes; i++)
      resources.push(
        res({
          id: `r${n}-${i}`,
          name: `res-${i}`,
          kind: pick(["postgres", "redis", "object_store", "queue", "email"] as const),
          size: pick(["nano", "small", "standard", "performance"] as const),
          config: rnd() < 0.3 ? { version: "16", flag: true, n: 3 } : {},
          ownership: rnd() < 0.15 ? "referenced" : "managed",
          externalRef: rnd() < 0.2 ? "x-1" : undefined,
        })
      );
    const bindings: Binding[] = [];
    const caps: Record<Resource["kind"], Binding["capability"]> = { postgres: "sql", redis: "cache", object_store: "blob", queue: "queue_publish", email: "smtp" };
    if (services.length)
      for (const r of resources) if (rnd() < 0.7) bindings.push(bind(`b${n}-${r.id}`, pick(services).id, r.id, caps[r.kind]));
    const routes: Route[] = rnd() < 0.5 ? [route({ id: `rt${n}`, host: `h${n}.example.com`, tls: rnd() < 0.5 })] : [];
    const web = services.find((s) => s.kind === "web");
    if (routes.length && web) bindings.push(bind(`br${n}`, routes[0].id, web.id, "http"));
    out.push(manifest({ services, resources, routes, bindings }));
  }
  return out;
}

/** Every V1 manifest source the repo can produce, by name. */
export function v1Fixtures(): { name: string; manifest: Manifest }[] {
  const out: { name: string; manifest: Manifest }[] = [];
  for (const bp of blueprints) out.push({ name: `blueprint:${bp.id}`, manifest: bp.manifestFactory("acme") });
  const composeYaml = fs.readFileSync(path.join(process.cwd(), "fixtures", "sample-app", "docker-compose.yml"), "utf8");
  out.push({ name: "importer:compose", manifest: importCompose(composeYaml, "proj-compose").manifest });
  out.push({
    name: "importer:dockerfile",
    manifest: importDockerfile("FROM node:22\nEXPOSE 8080\nENV NODE_ENV=production\nENV API_TOKEN=abc123\n", "app", "proj-df").manifest,
  });
  out.push({
    name: "importer:terraform",
    manifest: importTerraform(
      `resource "aws_db_instance" "main" {}\nresource "aws_s3_bucket" "assets" {}\nresource "aws_sqs_queue" "jobs" {}\nresource "aws_elasticache_cluster" "c" {}\n`
    ).manifest,
  });
  out.push({ name: "hand:empty", manifest: manifest({}) });
  out.push({ name: "hand:webDb", manifest: webDb() });
  out.push({ name: "hand:full", manifest: fullManifest() });
  randomManifests(120, 7).forEach((m, i) => out.push({ name: `random:${i}`, manifest: m }));
  return out;
}

/* ------------------------------ shuffling --------------------------------- */

export function shuffledCopy<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Same manifest, every order-insensitive list shuffled (including env vars). */
export function shuffledManifest(m: Manifest, seed: number): Manifest {
  return {
    ...m,
    services: shuffledCopy(m.services, seed).map((s, i) => ({ ...s, env: shuffledCopy(s.env, seed + i) })),
    resources: shuffledCopy(m.resources, seed + 1),
    routes: shuffledCopy(m.routes, seed + 2),
    bindings: shuffledCopy(m.bindings, seed + 3),
  };
}

/* ------------------------------ invariants -------------------------------- */

/** Structural facts every expanded graph must satisfy, whatever the manifest. */
export function graphProblems(g: ResourceGraph): string[] {
  const problems: string[] = [];
  const addrs = new Set(g.nodes.map((n) => n.address));
  if (addrs.size !== g.nodes.length) problems.push("duplicate addresses");
  const sorted = [...g.nodes.map((n) => n.address)].sort();
  if (canonical(sorted) !== canonical(g.nodes.map((n) => n.address))) problems.push("nodes not sorted by address");
  for (const n of g.nodes) {
    for (const d of n.dependsOn) if (!addrs.has(d)) problems.push(`${n.address} depends on missing ${d}`);
    if (n.dependsOn.includes(n.address)) problems.push(`${n.address} depends on itself`);
    if (!/^[a-z_]+\/[^/\s]+$/.test(n.address)) problems.push(`odd address ${n.address}`);
    if (!n.nativeType.includes(":")) problems.push(`${n.address} nativeType ${n.nativeType}`);
    if (n.ownership !== "managed" && n.dependsOn.length) problems.push(`${n.address} is ${n.ownership} but has dependencies`);
  }
  for (const e of g.edges) if (!addrs.has(e.from) || !addrs.has(e.to)) problems.push(`edge ${e.from}->${e.to} dangling`);

  // acyclic dependsOn
  const state = new Map<string, number>();
  const byAddr = new Map(g.nodes.map((n) => [n.address, n]));
  const visit = (a: string): boolean => {
    if (state.get(a) === 2) return false;
    if (state.get(a) === 1) return true;
    state.set(a, 1);
    for (const d of byAddr.get(a)?.dependsOn ?? []) if (visit(d)) return true;
    state.set(a, 2);
    return false;
  };
  for (const a of addrs) if (visit(a)) {
    problems.push("dependsOn cycle");
    break;
  }
  return problems;
}
