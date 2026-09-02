/**
 * Seed Orrery with a realistic demo workspace: Kepler Labs / project "atlas".
 * Produces: workspace, sandbox connection, project with deployed staging,
 * empty production (approval-gated), revision history, one past failed
 * deployment (for the recovery story), and security findings.
 *
 * Run: npm run seed   (wipes .data)
 */
import {
  appendEvent,
  db,
  resetDb,
  save,
} from "../src/lib/db/store";
import {
  emptyManifest,
  type Deployment,
  type DeploymentEvent,
  type Environment,
  type Manifest,
  type Project,
  type Revision,
  type Workspace,
} from "../src/lib/domain/types";
import { monthlyCostUsd } from "../src/lib/cost/pricing";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

async function main() {
  resetDb();
  const data = db();

  const ws: Workspace = {
    id: "ws-kepler",
    name: "Kepler Labs",
    slug: "kepler-labs",
    createdAt: iso(30 * DAY),
  };
  data.workspaces.push(ws);
  // Deliberately no member row: a seeded "you@kepler.dev" admin is a seat
  // nobody can sign in as, and it made every real signed-in user an editor
  // forever. Demo mode is admin with an empty member list; the first real
  // user to sign in claims the admin seat. (History below still carries the
  // "You" actor stamps — that is what actually happened.)

  data.connections.push({
    id: "conn-sandbox",
    workspaceId: ws.id,
    provider: "sandbox",
    label: "Orrery Sandbox",
    region: "local-1",
    status: "healthy",
    grantedPermissions: [
      "Provision simulated services and resources",
      "Read simulated logs, health, and cost estimates",
      "No access to any real cloud account",
    ],
    createdAt: iso(30 * DAY),
    lastCheckedAt: iso(2 * HOUR),
  });

  /* ---------------- manifest: the "atlas" SaaS ---------------- */

  let manifest: Manifest | undefined;
  try {
    const bp = await import("../src/lib/blueprints");
    const cat = (bp as { blueprints?: { id: string; manifestFactory: (s: string) => Manifest }[] }).blueprints;
    manifest = cat?.find((b) => b.id === "saas-standard")?.manifestFactory("atlas");
  } catch {
    /* blueprint module not present yet */
  }
  if (!manifest) manifest = fallbackManifest();

  const project: Project = {
    id: "prj-atlas",
    workspaceId: ws.id,
    name: "Atlas",
    slug: "atlas",
    workingManifest: manifest,
    createdAt: iso(21 * DAY),
    origin: { type: "blueprint", blueprint: "saas-standard" },
  };
  data.projects.push(project);

  /* ---------------- revisions r1..r3 ---------------- */

  const r1m = structuredClone(manifest);
  r1m.services = r1m.services.filter((s) => s.kind === "web");
  r1m.resources = r1m.resources.filter((r) => r.kind === "postgres");
  r1m.bindings = r1m.bindings.filter(
    (b) =>
      r1m.services.some((s) => s.id === b.from) &&
      (r1m.resources.some((r) => r.id === b.to) || r1m.services.some((s) => s.id === b.to))
  );
  r1m.routes = [];

  const r2m = structuredClone(manifest);
  r2m.resources = r2m.resources.filter((r) => r.kind !== "email");
  r2m.bindings = r2m.bindings.filter((b) => r2m.resources.some((r) => r.id === b.to) || r2m.services.some((s) => s.id === b.to));

  const mkRev = (n: number, m: Manifest, message: string, msAgo: number): Revision => ({
    id: `rev-atlas-${n}`,
    projectId: project.id,
    number: n,
    manifest: m,
    message,
    author: { type: "user", id: "m-you", name: "You" },
    createdAt: iso(msAgo),
  });

  const rev1 = mkRev(1, r1m, "Initial deploy: web + postgres", 20 * DAY);
  const rev2 = mkRev(2, r2m, "Add worker, cache, queue and storage", 12 * DAY);
  const rev3 = mkRev(3, manifest, "Add transactional email and public route", 3 * DAY);
  data.revisions.push(rev1, rev2, rev3);

  /* ---------------- environments ---------------- */

  const staging: Environment = {
    id: "env-staging",
    projectId: project.id,
    name: "staging",
    class: "staging",
    connectionId: "conn-sandbox",
    region: "local-1",
    deployedRevisionId: rev3.id,
    policies: { approvalRequired: false, budgetUsdMonthly: 120, allowStatefulDeletion: false },
    baseDomain: "atlas.orrery.app",
    createdAt: iso(21 * DAY),
  };
  const production: Environment = {
    id: "env-prod",
    projectId: project.id,
    name: "production",
    class: "production",
    connectionId: "conn-sandbox",
    region: "local-1",
    policies: { approvalRequired: true, allowStatefulDeletion: false },
    baseDomain: "atlas.orrery.app",
    createdAt: iso(21 * DAY),
  };
  data.environments.push(staging, production);

  /* ---------------- deployment history on staging ---------------- */

  seedDeployment(data.deployments, {
    id: "dep-1",
    env: staging,
    revision: rev1,
    summary: "Initial deploy: 1 service, 1 resource",
    msAgo: 20 * DAY,
    outcome: "succeeded",
  });
  seedDeployment(data.deployments, {
    id: "dep-2",
    env: staging,
    revision: rev2,
    summary: "4 created, 1 updated",
    msAgo: 12 * DAY,
    outcome: "succeeded",
    previous: rev1.id,
  });
  // The instructive failure: bad release, then successful retry.
  seedDeployment(data.deployments, {
    id: "dep-3",
    env: staging,
    revision: rev3,
    summary: "2 created, 1 updated",
    msAgo: 3 * DAY + 2 * HOUR,
    outcome: "failed",
    previous: rev2.id,
    failure: {
      stepTitle: "Release web",
      error:
        "Release failed: container exited during startup probe (exit 1). Check the service logs for the crash line, fix the start command, and redeploy.",
    },
  });
  seedDeployment(data.deployments, {
    id: "dep-4",
    env: staging,
    revision: rev3,
    summary: "Retry: 2 created, 1 updated",
    msAgo: 3 * DAY,
    outcome: "succeeded",
    previous: rev2.id,
  });

  save();

  /* findings, if the security module exists */
  try {
    const sec = await import("../src/lib/security/rules");
    (sec as { syncFindings?: (p: string) => void }).syncFindings?.(project.id);
  } catch {
    /* module arrives with workstream A */
  }

  const cost = monthlyCostUsd(manifest);
  console.log(`Seeded: workspace "Kepler Labs", project "atlas" (est. $${cost}/mo), staging deployed at r3, production empty (approval required).`);
}

/* Fabricated-but-plausible completed deployment history records. */
function seedDeployment(
  list: Deployment[],
  opts: {
    id: string;
    env: Environment;
    revision: Revision;
    summary: string;
    msAgo: number;
    outcome: "succeeded" | "failed";
    previous?: string;
    failure?: { stepTitle: string; error: string };
  }
) {
  const t0 = now - opts.msAgo;
  const phases: [string, "prepare" | "provision" | "release" | "verify"][] = [
    ["Resolve plan", "prepare"],
    ["Provision resources", "provision"],
    ["Release services", "release"],
    ["Verify health", "verify"],
  ];
  let cursor = t0;
  let seq = 0;
  const events: DeploymentEvent[] = [];
  const steps = phases.map(([title, phase], i) => {
    const dur = 2500 + i * 1800;
    const failsHere = opts.failure && title.startsWith("Release") ? true : false;
    const failed = opts.outcome === "failed" && failsHere;
    const step = {
      id: `${opts.id}-s${i}`,
      seq: i,
      phase,
      title: opts.failure && phase === "release" ? opts.failure.stepTitle : title,
      targetId: "",
      status: (failed
        ? "failed"
        : opts.outcome === "failed" && phase === "verify"
          ? "skipped"
          : "done") as "done" | "failed" | "skipped",
      startedAt: new Date(cursor).toISOString(),
      endedAt: new Date(cursor + dur).toISOString(),
      error: failed ? opts.failure!.error : undefined,
    };
    events.push({
      ts: step.startedAt!,
      deploymentId: opts.id,
      seq: seq++,
      type: "step",
      stepId: step.id,
      status: failed ? "failed" : step.status,
      error: step.error,
    });
    cursor += dur;
    return step;
  });

  const dep: Deployment = {
    id: opts.id,
    projectId: opts.env.projectId,
    environmentId: opts.env.id,
    revisionId: opts.revision.id,
    status: opts.outcome,
    steps,
    outputs:
      opts.outcome === "succeeded"
        ? [
            {
              key: "url-web",
              label: `web — https://web--${opts.env.name}.atlas.orrery.app`,
              value: `/preview/${opts.id}/svc-web`,
              kind: "url",
              targetId: "svc-web",
            },
          ]
        : [],
    changeSummary: opts.summary,
    estCostDeltaUsd: 0,
    actor: { type: "user", id: "m-you", name: "You" },
    createdAt: new Date(t0).toISOString(),
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(cursor).toISOString(),
    error: opts.failure?.error,
    previousRevisionId: opts.previous,
  };
  list.push(dep);
  for (const e of events) appendEvent(e);
}

/** Hand-built manifest used until the blueprint catalog lands. */
function fallbackManifest(): Manifest {
  const m = emptyManifest();
  m.services = [
    {
      id: "svc-web", name: "web", kind: "web",
      source: { type: "image", image: "ghcr.io/kepler/atlas-web:1.4.2" },
      size: "small", replicas: 2, port: 3000, healthPath: "/healthz",
      env: [{ key: "NODE_ENV", value: "production" }],
      ownership: "managed",
    },
    {
      id: "svc-worker", name: "worker", kind: "worker",
      source: { type: "image", image: "ghcr.io/kepler/atlas-worker:1.4.2" },
      size: "small", replicas: 1, env: [], ownership: "managed",
    },
    {
      id: "svc-digest", name: "digest", kind: "cron",
      source: { type: "image", image: "ghcr.io/kepler/atlas-jobs:1.4.2" },
      size: "nano", replicas: 1, schedule: "0 7 * * *", env: [], ownership: "managed",
    },
  ];
  m.resources = [
    { id: "res-db", name: "main-db", kind: "postgres", config: { version: "16" }, size: "small", ownership: "managed" },
    { id: "res-cache", name: "cache", kind: "redis", config: {}, size: "nano", ownership: "managed" },
    { id: "res-uploads", name: "uploads", kind: "object_store", config: {}, size: "small", ownership: "managed" },
    { id: "res-jobs", name: "jobs", kind: "queue", config: {}, size: "nano", ownership: "managed" },
    { id: "res-mail", name: "mail", kind: "email", config: {}, size: "nano", ownership: "managed" },
  ];
  m.routes = [{ id: "rt-app", host: "app.atlas.orrery.app", pathPrefix: "/", tls: true, managedDns: true }];
  m.bindings = [
    { id: "b1", from: "rt-app", to: "svc-web", capability: "http", note: "public traffic, TLS terminated at the edge" },
    { id: "b2", from: "svc-web", to: "res-db", capability: "sql", note: "web reads and writes application data" },
    { id: "b3", from: "svc-web", to: "res-cache", capability: "cache", note: "sessions and hot lookups" },
    { id: "b4", from: "svc-web", to: "res-uploads", capability: "blob", note: "user file uploads" },
    { id: "b5", from: "svc-web", to: "res-jobs", capability: "queue_publish", note: "enqueue background work" },
    { id: "b6", from: "svc-worker", to: "res-jobs", capability: "queue_consume", note: "process background jobs" },
    { id: "b7", from: "svc-worker", to: "res-db", capability: "sql", note: "worker persists job results" },
    { id: "b8", from: "svc-worker", to: "res-mail", capability: "smtp", note: "send transactional email" },
    { id: "b9", from: "svc-digest", to: "res-db", capability: "sql", note: "nightly digest reads activity" },
    { id: "b10", from: "svc-digest", to: "res-mail", capability: "smtp", note: "deliver the digest" },
  ];
  return m;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
