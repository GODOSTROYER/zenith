/**
 * Blueprints: opinionated starting systems.
 *
 * A blueprint is a manifest factory, nothing more — after applying one you
 * hold an ordinary working manifest and every node is editable. Sizes and
 * replicas are explicit so the cost estimate is honest from the first render.
 */
import { id } from "@/lib/domain/types";
import type {
  Binding,
  BindingCapability,
  Manifest,
  Resource,
  ResourceKind,
  Route,
  Service,
  ServiceKind,
  ServiceSize,
} from "@/lib/domain/types";

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  /** lucide-react icon name, rendered by the UI */
  icon: string;
  /** what you get, in one glance */
  highlights: string[];
  manifestFactory(projectSlug: string): Manifest;
}

/* ------------------------------- tiny builders ----------------------------- */

function svc(
  name: string,
  kind: ServiceKind,
  opts: {
    size?: ServiceSize;
    replicas?: number;
    port?: number;
    healthPath?: string;
    schedule?: string;
    image?: string;
  } = {}
): Service {
  return {
    id: id(),
    name,
    kind,
    source: opts.image
      ? { type: "image", image: opts.image }
      : { type: "blueprint", blueprint: name },
    size: opts.size ?? "small",
    replicas: opts.replicas ?? 1,
    port: opts.port,
    healthPath: opts.healthPath,
    schedule: opts.schedule,
    env: [],
    ownership: "managed",
  };
}

function res(name: string, kind: ResourceKind, size: ServiceSize = "small"): Resource {
  return { id: id(), name, kind, config: {}, size, ownership: "managed" };
}

function route(projectSlug: string, host = `app.${projectSlug}.orrery.app`): Route {
  return { id: id(), host, pathPrefix: "/", tls: true, managedDns: true };
}

function bind(from: { id: string }, to: { id: string }, capability: BindingCapability, note: string): Binding {
  return { id: id(), from: from.id, to: to.id, capability, note };
}

const manifest = (parts: {
  services: Service[];
  resources?: Resource[];
  routes?: Route[];
  bindings: Binding[];
}): Manifest => ({
  version: 1,
  services: parts.services,
  resources: parts.resources ?? [],
  routes: parts.routes ?? [],
  bindings: parts.bindings,
});

/* -------------------------------- the catalog ------------------------------ */

export const blueprints: Blueprint[] = [
  {
    id: "local-resources",
    name: "Local resources starter",
    description: "A managed S3 bucket and SQS queue—the resources LocalStack can provision and read back here. No simulated app services or public routes.",
    icon: "Boxes",
    highlights: ["S3 bucket", "SQS queue", "LocalStack supported", "no public endpoint"],
    manifestFactory() {
      return manifest({ services: [], resources: [res("assets", "object_store"), res("jobs", "queue")], bindings: [] });
    },
  },
  {
    id: "saas-standard",
    name: "Standard SaaS",
    description:
      "The shape most products end up with: a web app, a background worker, Postgres, Redis, a job queue and transactional email.",
    icon: "Boxes",
    highlights: ["web + worker", "Postgres + Redis", "queue + email", "public route with TLS"],
    manifestFactory(slug) {
      const web = svc("web", "web", { size: "standard", replicas: 2, port: 3000, healthPath: "/healthz" });
      const worker = svc("worker", "worker", { size: "small" });
      const pg = res("postgres", "postgres", "standard");
      const redis = res("cache", "redis");
      const queue = res("jobs", "queue");
      const email = res("mail", "email");
      const r = route(slug);
      return manifest({
        services: [web, worker],
        resources: [pg, redis, queue, email],
        routes: [r],
        bindings: [
          bind(r, web, "http", "Public traffic reaches web over HTTPS."),
          bind(web, pg, "sql", "web reads and writes application data in postgres."),
          bind(web, redis, "cache", "web caches sessions and hot reads in cache."),
          bind(web, queue, "queue_publish", "web enqueues background work on jobs."),
          bind(web, email, "smtp", "web sends transactional mail through mail."),
          bind(worker, pg, "sql", "worker reads and writes the same data as web."),
          bind(worker, queue, "queue_consume", "worker drains jobs and runs them."),
          bind(worker, email, "smtp", "worker sends digests and receipts."),
        ],
      });
    },
  },
  {
    id: "api-worker",
    name: "API + worker",
    description: "A JSON API with an async worker behind a queue. No frontend, no cache — the smallest honest backend.",
    icon: "Cpu",
    highlights: ["HTTP API", "queue-backed worker", "Postgres", "public route with TLS"],
    manifestFactory(slug) {
      const api = svc("api", "web", { size: "standard", replicas: 2, port: 8080, healthPath: "/health" });
      const worker = svc("worker", "worker");
      const pg = res("postgres", "postgres", "standard");
      const queue = res("jobs", "queue");
      const r = route(slug, `api.${slug}.orrery.app`);
      return manifest({
        services: [api, worker],
        resources: [pg, queue],
        routes: [r],
        bindings: [
          bind(r, api, "http", "Public traffic reaches api over HTTPS."),
          bind(api, pg, "sql", "api reads and writes application data in postgres."),
          bind(api, queue, "queue_publish", "api enqueues work instead of blocking a request."),
          bind(worker, queue, "queue_consume", "worker drains jobs."),
          bind(worker, pg, "sql", "worker writes results back to postgres."),
        ],
      });
    },
  },
  {
    id: "static-api",
    name: "Static site + API",
    description: "A prebuilt frontend served as static files, calling a small API with a database behind it.",
    icon: "Globe",
    highlights: ["static frontend", "HTTP API", "Postgres", "public route with TLS"],
    manifestFactory(slug) {
      const site = svc("site", "static");
      const api = svc("api", "web", { port: 8080, healthPath: "/health" });
      const pg = res("postgres", "postgres");
      const r = route(slug);
      return manifest({
        services: [site, api],
        resources: [pg],
        routes: [r],
        bindings: [
          bind(r, api, "http", "Public traffic reaches api over HTTPS; api serves the site's data."),
          bind(site, api, "http", "site calls api from the browser; its URL is injected at build time."),
          bind(api, pg, "sql", "api reads and writes application data in postgres."),
        ],
      });
    },
  },
  {
    id: "ai-app",
    name: "AI application",
    description:
      "A chat or generation app: web front door, a worker for long-running model calls, Postgres for history, object storage for artifacts and a queue between them.",
    icon: "Sparkles",
    highlights: ["web + inference worker", "Postgres + object storage", "queue for long jobs", "public route with TLS"],
    manifestFactory(slug) {
      const web = svc("web", "web", { size: "standard", replicas: 2, port: 3000, healthPath: "/healthz" });
      const worker = svc("inference", "worker", { size: "performance" });
      const pg = res("postgres", "postgres", "standard");
      const bucket = res("artifacts", "object_store", "standard");
      const queue = res("jobs", "queue");
      const r = route(slug);
      return manifest({
        services: [web, worker],
        resources: [pg, bucket, queue],
        routes: [r],
        bindings: [
          bind(r, web, "http", "Public traffic reaches web over HTTPS."),
          bind(web, pg, "sql", "web stores conversations and prompts in postgres."),
          bind(web, queue, "queue_publish", "web queues generation requests so requests never block."),
          bind(web, bucket, "blob", "web serves generated files from artifacts."),
          bind(worker, queue, "queue_consume", "inference picks up generation jobs."),
          bind(worker, pg, "sql", "inference writes results and token usage back."),
          bind(worker, bucket, "blob", "inference uploads generated files to artifacts."),
        ],
      });
    },
  },
  {
    id: "internal-tool",
    name: "Internal tool",
    description: "One web service and a database. The right size for an admin panel or an ops dashboard.",
    icon: "Wrench",
    highlights: ["single web service", "Postgres", "public route with TLS", "cheapest to run"],
    manifestFactory(slug) {
      const web = svc("app", "web", { port: 3000, healthPath: "/healthz" });
      const pg = res("postgres", "postgres");
      const r = route(slug, `tools.${slug}.orrery.app`);
      return manifest({
        services: [web],
        resources: [pg],
        routes: [r],
        bindings: [
          bind(r, web, "http", "Public traffic reaches app over HTTPS."),
          bind(web, pg, "sql", "app reads and writes its data in postgres."),
        ],
      });
    },
  },
  {
    id: "cron-automation",
    name: "Scheduled automation",
    description: "A job on a schedule, a database to keep state, and email to report what it did. No public surface at all.",
    icon: "CalendarClock",
    highlights: ["cron job (hourly)", "Postgres", "email reports", "no public route"],
    manifestFactory() {
      const job = svc("job", "cron", { schedule: "0 * * * *" });
      const pg = res("postgres", "postgres", "nano");
      const email = res("mail", "email", "nano");
      return manifest({
        services: [job],
        resources: [pg, email],
        bindings: [
          bind(job, pg, "sql", "job records each run and its results in postgres."),
          bind(job, email, "smtp", "job emails a summary when it finishes."),
        ],
      });
    },
  },
];

export function getBlueprint(blueprintId: string): Blueprint | undefined {
  return blueprints.find((b) => b.id === blueprintId);
}
