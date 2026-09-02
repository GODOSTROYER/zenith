/**
 * Synthetic application logs and health for sandbox environments.
 *
 * Deterministic by construction: a line is a pure function of
 * (environment, service, 2-second bucket), so two readers — or the same
 * reader after a refresh — see identical history, and `?after=seq` replay
 * works without storing anything.
 *
 * Honesty rule: `health()` is computed from the same facts the log lines are
 * generated from. If the logs show errors, health says degraded.
 *
 * Workstream A.
 */
import { db, q } from "@/lib/db/store";
import { fnv1a, type Deployment, type Manifest, type Service } from "@/lib/domain/types";
import { chaosFlag } from "@/lib/providers/sandbox";

export interface AppLogLine {
  seq: number;
  ts: string;
  line: string;
  stream: "stdout" | "stderr";
}

export interface ServiceHealth {
  status: "ok" | "degraded";
  replicasReady: number;
  replicasDesired: number;
  latencyMs: number;
  /** why it looks the way it does — health is never asserted without a reason */
  reason: string;
  /** state changes in the last hour, oldest first (see `healthHistory`) */
  history: HealthEvent[];
}

/** A point where a service's simulated health changed, and what caused it. */
export interface HealthEvent {
  /** when the change happened — the deployment that caused it finished */
  at: string;
  status: "ok" | "degraded" | "absent";
  reason: string;
  revisionNumber: number;
}

/** One line every 2 seconds. */
const BUCKET_MS = 2000;
const MAX_BACKLOG = 200;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

/* --------------------------------- context -------------------------------- */

interface Ctx {
  service: Service;
  manifest: Manifest;
  /** ms since epoch when the service started serving */
  since: number;
  chaos?: string;
}

function contextFor(envId: string, serviceId: string): Ctx | undefined {
  const env = q.environment(envId);
  if (!env) return undefined;
  const last = db()
    .deployments.filter((d) => d.environmentId === envId && d.status === "succeeded")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] as Deployment | undefined;
  if (!last) return undefined;
  const revision = q.revision(last.revisionId);
  if (!revision) return undefined;
  const service = revision.manifest.services.find((s) => s.id === serviceId);
  if (!service) return undefined;
  return {
    service,
    manifest: revision.manifest,
    since: Date.parse(last.endedAt ?? last.createdAt),
    chaos: chaosFlag(service),
  };
}

/* ---------------------------------- lines --------------------------------- */

const PATHS = ["/", "/healthz", "/api/orders", "/api/orders/8821", "/api/users/me", "/api/search?q=shoes", "/assets/app.css", "/api/checkout"] as const;
const METHODS = ["GET", "GET", "GET", "POST", "PUT"] as const;
const JOBS = ["reindex-catalog", "send-digest", "expire-carts", "sync-inventory", "rollup-metrics"] as const;

function webLine(rng: () => number, c: Ctx, ts: Date): { line: string; stream: "stdout" | "stderr" } {
  const path = pick(rng, PATHS);
  const method = pick(rng, METHODS);
  const slow = rng() < 0.06;
  const err = c.chaos === "degrade" ? rng() < 0.18 : rng() < 0.02;
  const status = err ? (rng() < 0.5 ? 502 : 500) : path === "/api/checkout" && rng() < 0.1 ? 402 : 200;
  const ms = slow ? 400 + Math.floor(rng() * 1800) : 4 + Math.floor(rng() * 90);
  const ip = `10.0.${1 + Math.floor(rng() * 3)}.${10 + Math.floor(rng() * 200)}`;
  const rid = fnv1a(`${c.service.id}${ts.getTime()}`).toString(16).slice(0, 8);
  if (err)
    return {
      stream: "stderr",
      line: `${ts.toISOString()} ERROR req=${rid} ${method} ${path} ${status} ${ms}ms upstream_error="dependency timed out"`,
    };
  return {
    stream: "stdout",
    line: `${ts.toISOString()} INFO  req=${rid} ${method} ${path} ${status} ${ms}ms ${ip}`,
  };
}

function workerLine(rng: () => number, c: Ctx, ts: Date): { line: string; stream: "stdout" | "stderr" } {
  const job = pick(rng, JOBS);
  const n = 1 + Math.floor(rng() * 240);
  const ms = 40 + Math.floor(rng() * 3000);
  const err = c.chaos === "degrade" ? rng() < 0.2 : rng() < 0.03;
  if (err)
    return {
      stream: "stderr",
      line: `${ts.toISOString()} WARN  job=${job} attempt=2 retrying after error="lock contention"`,
    };
  return {
    stream: "stdout",
    line: `${ts.toISOString()} INFO  job=${job} processed=${n} in ${ms}ms`,
  };
}

function cronLine(rng: () => number, c: Ctx, ts: Date): { line: string; stream: "stdout" | "stderr" } {
  const ms = 200 + Math.floor(rng() * 8000);
  return {
    stream: "stdout",
    line: `${ts.toISOString()} INFO  run schedule="${c.service.schedule ?? "* * * * *"}" exit=0 duration=${ms}ms`,
  };
}

/**
 * Logs for a service since its last successful deployment.
 * `afterSeq` is the cursor an SSE client reconnects with.
 */
export function getServiceLogs(
  envId: string,
  serviceId: string,
  afterSeq = -1
): AppLogLine[] {
  const c = contextFor(envId, serviceId);
  if (!c || c.service.kind === "static") return [];

  const now = Date.now();
  const total = Math.max(0, Math.floor((now - c.since) / BUCKET_MS));
  const first = Math.max(0, total - MAX_BACKLOG);
  const out: AppLogLine[] = [];

  for (let seq = Math.max(first, afterSeq + 1); seq < total; seq++) {
    const rng = mulberry32(fnv1a(`${envId}:${serviceId}:${seq}`));
    const ts = new Date(c.since + seq * BUCKET_MS);
    const made =
      c.service.kind === "web"
        ? webLine(rng, c, ts)
        : c.service.kind === "cron"
          ? cronLine(rng, c, ts)
          : workerLine(rng, c, ts);
    out.push({ seq, ts: ts.toISOString(), line: made.line, stream: made.stream });
  }
  return out;
}

/* -------------------------------- history --------------------------------- */

const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const MAX_HISTORY = 12;

/**
 * What this service's health was under one revision.
 *
 * Same rule `health()` uses below, so history and the current state can never
 * contradict each other: the chaos flag on the deployed service decides, and
 * a service that is not in a revision was not running under it.
 */
function statusUnder(
  revisionId: string,
  serviceId: string
): { status: HealthEvent["status"]; reason: string; revisionNumber: number } | undefined {
  const revision = q.revision(revisionId);
  if (!revision) return undefined;
  const service = revision.manifest.services.find((s) => s.id === serviceId);
  if (!service)
    return {
      status: "absent",
      reason: `Not part of r${revision.number} — nothing was running.`,
      revisionNumber: revision.number,
    };
  const desired = Math.max(1, service.replicas);
  return chaosFlag(service) === "degrade"
    ? {
        status: "degraded",
        reason: `r${revision.number} started ${service.name} with a replica that fails its health probe.`,
        revisionNumber: revision.number,
      }
    : {
        status: "ok",
        reason: `r${revision.number} started ${desired} healthy replica(s).`,
        revisionNumber: revision.number,
      };
}

/**
 * Health transitions for a service over the last hour, oldest first.
 *
 * Derived, not retained: simulated health only changes when a deployment
 * changes what is running, and those are durable records — so re-reading this
 * after a restart gives the same answer, with nothing stored in between. The
 * state the window opened in is included, dated when it actually started.
 */
export function healthHistory(
  envId: string,
  serviceId: string,
  now = Date.now(),
  windowMs = HISTORY_WINDOW_MS
): HealthEvent[] {
  const deployments = db()
    .deployments.filter((d) => d.environmentId === envId && d.status === "succeeded")
    .sort((a, b) => ((a.endedAt ?? a.createdAt) < (b.endedAt ?? b.createdAt) ? -1 : 1));

  const transitions: HealthEvent[] = [];
  let previous: HealthEvent["status"] | undefined;
  for (const d of deployments) {
    const under = statusUnder(d.revisionId, serviceId);
    if (!under || under.status === previous) continue;
    // "absent" before the service has ever appeared is not a change worth
    // reporting — history starts when the service first ran here.
    if (previous === undefined && under.status === "absent") continue;
    previous = under.status;
    transitions.push({ at: d.endedAt ?? d.createdAt, ...under });
  }

  // Everything inside the window, plus the state it opened in.
  const from = now - windowMs;
  const inWindow = transitions.filter((t) => Date.parse(t.at) >= from);
  const opening = [...transitions].reverse().find((t) => Date.parse(t.at) < from);
  return [...(opening ? [opening] : []), ...inWindow].slice(-MAX_HISTORY);
}

/**
 * Health for a service, computed from the same inputs as the log stream.
 * Never optimistic: no successful deployment means no health to report.
 */
export function health(envId: string, serviceId: string): ServiceHealth {
  const c = contextFor(envId, serviceId);
  if (!c)
    return {
      status: "degraded",
      replicasReady: 0,
      replicasDesired: 0,
      latencyMs: 0,
      reason: "Nothing has been deployed to this environment yet.",
      history: [],
    };

  const desired = Math.max(1, c.service.replicas);
  const rng = mulberry32(fnv1a(`${envId}:${serviceId}:${Math.floor(Date.now() / 10000)}`));
  const latencyMs = 8 + Math.floor(rng() * (c.chaos === "degrade" ? 400 : 70));
  const history = healthHistory(envId, serviceId);

  if (c.chaos === "degrade") {
    const ready = Math.max(0, desired - 1);
    return {
      status: "degraded",
      replicasReady: ready,
      replicasDesired: desired,
      latencyMs,
      reason: `${desired - ready} of ${desired} replica(s) are failing their health probe.`,
      history,
    };
  }

  return {
    status: "ok",
    replicasReady: desired,
    replicasDesired: desired,
    latencyMs,
    reason: `All ${desired} replica(s) passing health checks since the last successful deployment.`,
    history,
  };
}

/** Health for every managed service in an environment. */
export function environmentHealth(envId: string): Record<string, ServiceHealth> {
  const c = q.environment(envId);
  if (!c?.deployedRevisionId) return {};
  const revision = q.revision(c.deployedRevisionId);
  if (!revision) return {};
  const out: Record<string, ServiceHealth> = {};
  for (const s of revision.manifest.services) {
    if (s.ownership !== "managed") continue;
    out[s.id] = health(envId, s.id);
  }
  return out;
}
