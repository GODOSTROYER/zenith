/**
 * Workload probes: the service's runtime state, its application logs, and its
 * resource saturation.
 *
 *   service.running_vs_desired / service.stopped_tasks / service.rollout /
 *   service.image_pull                      (runtime state + provider events)
 *   logs.<signature>                        (bounded log search, fixed table)
 *   capacity.cpu / capacity.memory          (utilization metrics)
 *
 * Log and event text is untrusted: it is matched only against the signature
 * table in `./signatures` and quoted only as redacted, length-capped excerpts
 * (see `./sanitize`). A line that matches nothing has no effect.
 *
 * Attribution. A connection timeout or refusal is tied to a dependency by the
 * PORT the log line names, matched against the ports the graph says this
 * service uses (edge detail `sql:5432`, firewall rules). A port no dependency
 * uses stays a generic `logs.connect_timeout`: it is never pinned on the
 * database just because a database exists.
 */
import type { DependencyClass, PathStep, RequestPath } from "./traverse";
import type { ProbeContext, TextBundle } from "./probe-context";
import type { Probe } from "./probe-types";
import { num, parseSignals, plural, round, summarizeSeries, toPercent } from "./probe-util";
import { SIGNATURE_BY_ID, type SignatureHit, type SignatureId } from "./signatures";
import type { Evidence } from "./types";

const allUnknown = (probe: Probe, step: PathStep, ctx: ProbeContext, why: string): Evidence[] => probe.checks.map((c) => ctx.unknown(probe.hop, step.address, c, why));

/* --------------------------------- runtime ---------------------------------- */

export const serviceProbe: Probe = {
  id: "service",
  hop: "container",
  checks: ["service.running_vs_desired", "service.stopped_tasks", "service.rollout", "service.image_pull"],
  async run(step, ctx) {
    const address = step.address;
    const rt = await ctx.runtime(address);
    if (!rt.ok) return allUnknown(serviceProbe, step, ctx, rt.message);
    const r = rt.value;
    const sig = parseSignals(r);
    const common = { hop: "container" as const, address, simulated: r.simulated, source: r.source, observedAt: r.observedAt };
    const read = r.health !== "unknown" || sig.informative;
    const unreadWhy = `the runtime state was not read${sig.readFailed ? ` (${sig.readFailed})` : sig.countsNotRead ? " (counts not read)" : ""}`;
    const out: Evidence[] = [];

    const desired = num(r.counts, "desired");
    const running = num(r.counts, "running");
    const pending = num(r.counts, "pending");
    if (desired === undefined || running === undefined) {
      out.push(ctx.evidence({ ...common, check: "service.running_vs_desired", outcome: "unknown", finding: `How many tasks of ${address} are running was not read.`, data: { health: r.health } }));
    } else {
      const short = running < desired || desired === 0;
      out.push(
        ctx.evidence({
          ...common,
          check: "service.running_vs_desired",
          outcome: short ? "fail" : "pass",
          finding:
            desired === 0
              ? `${address} is scaled to zero: desired count is 0, so it serves nothing.`
              : short
                ? `${address} has ${running} of ${desired} desired tasks running${pending ? ` (${pending} pending)` : ""}.`
                : `${address} has all ${desired} desired tasks running.`,
          data: { desired, running, pending: pending ?? null, none: running === 0, scaledToZero: desired === 0, health: r.health },
        })
      );
    }

    if (sig.stopped.length > 0) {
      const reasons = [...new Set(sig.stopped)].sort().slice(0, 6);
      out.push(
        ctx.evidence({
          ...common,
          check: "service.stopped_tasks",
          outcome: "fail",
          finding: `Tasks of ${address} stopped abnormally: ${reasons.join(", ")}${sig.exitCodes.length ? `; exit code ${[...new Set(sig.exitCodes)].slice(0, 3).join(", ")}` : ""}.`,
          data: { reasons, oom: sig.oom, imagePull: sig.imagePull, exitCodes: [...new Set(sig.exitCodes)].slice(0, 5), recent: num(r.counts, "tasks_stopped_recent") ?? null },
        })
      );
    } else if (read) {
      out.push(ctx.evidence({ ...common, check: "service.stopped_tasks", outcome: "pass", finding: `No abnormally stopped tasks of ${address} were reported.`, data: { oom: false, imagePull: false } }));
    } else out.push(ctx.unknown("container", address, "service.stopped_tasks", unreadWhy));

    if (sig.deploymentFailed) {
      out.push(ctx.evidence({ ...common, check: "service.rollout", outcome: "fail", finding: `The latest rollout of ${address} failed (the deployment circuit breaker or rollout check reported failure).`, data: { failed: true, inProgress: sig.deploymentInProgress } }));
    } else if (read) {
      out.push(ctx.evidence({ ...common, check: "service.rollout", outcome: "pass", finding: sig.deploymentInProgress ? `A rollout of ${address} is in progress and has not failed.` : `No failed rollout of ${address} was reported.`, data: { failed: false, inProgress: sig.deploymentInProgress } }));
    } else out.push(ctx.unknown("container", address, "service.rollout", unreadWhy));

    // image pull: runtime signals, plus provider events / logs when those were readable
    const text = await ctx.text(address);
    const pull = text.ok ? text.value.hits.find((h) => h.signature === "image_pull") : undefined;
    const coverage = ["runtime", ...(text.ok ? ["logs", ...(text.value.eventsRead ? ["events"] : [])] : [])];
    if (sig.imagePull || pull) {
      out.push(
        ctx.evidence({
          ...common,
          simulated: r.simulated || (text.ok && text.value.simulated),
          check: "service.image_pull",
          outcome: "fail",
          finding: `${address} could not pull its container image${pull ? ` (${plural(pull.count, "matching line")})` : ""}.`,
          data: { fromRuntime: sig.imagePull, fromText: pull !== undefined, samples: pull?.samples ?? [], count: pull?.count ?? null, coverage },
        })
      );
    } else if (read) {
      out.push(ctx.evidence({ ...common, check: "service.image_pull", outcome: "pass", finding: `No image pull failure was reported for ${address} (looked at: ${coverage.join(", ")}).`, data: { coverage } }));
    } else out.push(ctx.unknown("container", address, "service.image_pull", unreadWhy));
    return out;
  },
};

/* ------------------------------ application logs ---------------------------- */

const CHECK_OF: Readonly<Record<SignatureId, string>> = {
  connect_timeout: "logs.connect_timeout",
  connect_refused: "logs.connect_refused",
  dns_failure: "logs.dns_failure",
  auth_failure: "logs.db_auth_failure",
  db_unavailable: "logs.db_unavailable",
  oom: "logs.oom",
  http_5xx: "logs.http_5xx",
  missing_env: "logs.missing_env",
  secret_error: "logs.secret_error",
  iam_denied: "logs.iam_denied",
  image_pull: "logs.image_pull",
  tls_error: "logs.tls_error",
};

const DEFAULT_PORT: Readonly<Record<string, number>> = { postgres: 5432, mysql: 3306, redis: 6379 };
const CLASS_PREFIX: Readonly<Record<DependencyClass, string>> = { database: "db", cache: "cache", queue: "queue", storage: "storage", service: "service" };

interface Dep {
  address: string;
  klass: DependencyClass;
  candidates: number;
}

/** port → dependency, for the dependencies of `service` the graph names. */
export function dependencyPorts(path: RequestPath, service: string, kindOf: (address: string) => string | undefined): Map<number, Dep> {
  const out = new Map<number, Dep>();
  for (const s of path.steps) {
    const d = s.dependency;
    if (!d || d.client !== service || (d.class !== "database" && d.class !== "cache")) continue;
    const port = d.port ?? DEFAULT_PORT[kindOf(d.address) ?? ""];
    if (port === undefined) continue;
    const prev = out.get(port);
    if (!prev) out.set(port, { address: d.address, klass: d.class, candidates: 1 });
    else if (prev.address !== d.address) prev.candidates += 1;
  }
  return out;
}

/** Signatures another hop reports for this service, so the path does not count one log line twice. */
function ownedElsewhere(path: RequestPath, service: string, id: SignatureId): boolean {
  if (id === "image_pull") return true; // reported with the runtime state (service.image_pull)
  if (id === "iam_denied") return path.steps.some((s) => s.hop === "identity" && s.owner === service);
  if (id === "secret_error") return path.steps.some((s) => s.hop === "secret" && s.owner === service);
  return false;
}

/** Every `logs.*` check name the application probe can emit (rules are tested against this list). */
export const LOG_CHECKS: readonly string[] = [
  ...new Set([
    ...Object.values(CHECK_OF),
    ...(["connect_timeout", "connect_refused"] as const).flatMap((id) => (["database", "cache"] as const).map((k) => `logs.${CLASS_PREFIX[k]}_${id}`)),
  ]),
].sort();

export function hitCheck(hit: SignatureHit, dep: Dep | undefined): string {
  if (dep && (hit.signature === "connect_timeout" || hit.signature === "connect_refused")) return `logs.${CLASS_PREFIX[dep.klass]}_${hit.signature}`;
  return CHECK_OF[hit.signature];
}

export function hitData(hit: SignatureHit, dep?: Dep): Record<string, unknown> {
  return {
    signatureId: hit.signature,
    count: hit.count,
    firstAt: hit.firstAt ?? null,
    lastAt: hit.lastAt ?? null,
    samples: hit.samples,
    sources: hit.sources,
    ports: hit.ports,
    hosts: hit.hosts,
    ...(hit.envVars.length ? { envVars: hit.envVars } : {}),
    ...(hit.actions.length ? { actions: hit.actions } : {}),
    ...(dep ? { dependencyClass: dep.klass, dependency: dep.address, ambiguousDependency: dep.candidates > 1 } : {}),
  };
}

export const applicationProbe: Probe = {
  id: "application",
  hop: "application",
  checks: ["logs.error_signatures"],
  async run(step, ctx, path) {
    const address = step.address;
    const got = await ctx.text(address);
    if (!got.ok) return [ctx.unknown("application", address, "logs.error_signatures", got.message)];
    const tb: TextBundle = got.value;
    const common = { hop: "application" as const, address, simulated: tb.simulated, source: tb.sources.join(",") || undefined };
    const deps = dependencyPorts(path, address, (a) => ctx.node(a)?.kind);
    const out: Evidence[] = [];
    const below: Record<string, number> = {};

    for (const hit of tb.hits) {
      if (ownedElsewhere(path, address, hit.signature)) continue;
      const sig = SIGNATURE_BY_ID[hit.signature];
      if (hit.count < sig.minCount) {
        below[hit.signature] = (below[hit.signature] ?? 0) + hit.count;
        continue;
      }
      const dep = hit.port !== undefined ? deps.get(hit.port) : undefined;
      const check = hitCheck(hit, dep);
      out.push(
        ctx.evidence({
          ...common,
          check,
          outcome: "fail",
          key: hit.port !== undefined ? `p${hit.port}` : undefined,
          finding: `${address} logged ${sig.description}: ${plural(hit.count, "line")} between ${hit.firstAt ?? "?"} and ${hit.lastAt ?? "?"}${hit.port !== undefined ? `, port ${hit.port}${dep ? ` (${dep.address})` : ""}` : ""}.`,
          data: hitData(hit, dep),
        })
      );
    }
    if (out.length > 0) return out;

    const partial = tb.unavailable.length > 0;
    if (tb.scanned === 0 || partial)
      return [
        ctx.evidence({
          ...common,
          check: "logs.error_signatures",
          outcome: "unknown",
          finding: tb.scanned === 0 ? `No log lines were returned for ${address} in the window, so nothing can be said about its errors.` : `Logs for ${address} were only partly readable, and no known error signature appeared in what was read.`,
          data: { scanned: tb.scanned, unavailable: tb.unavailable.slice(0, 4), belowThreshold: below },
        }),
      ];
    return [
      ctx.evidence({
        ...common,
        check: "logs.error_signatures",
        outcome: "pass",
        finding: `No known error signature appeared in ${plural(tb.scanned, "log line")} of ${address}${tb.truncated ? " (the most recent lines only)" : ""}.`,
        data: { scanned: tb.scanned, truncated: tb.truncated, belowThreshold: below, foreign: tb.foreign },
      }),
    ];
  },
};

/* --------------------------------- capacity --------------------------------- */

const SATURATED_PERCENT = 85;

export const capacityProbe: Probe = {
  id: "capacity",
  hop: "container",
  checks: ["capacity.cpu", "capacity.memory"],
  async run(step, ctx) {
    const address = step.address;
    const m = await ctx.metrics(address, ["cpu.utilization", "memory.utilization"]);
    if (!m.ok) return allUnknown(capacityProbe, step, ctx, m.message);
    const out: Evidence[] = [];
    for (const [metric, check, label] of [["cpu.utilization", "capacity.cpu", "CPU"], ["memory.utilization", "capacity.memory", "Memory"]] as const) {
      const series = m.value.series.find((s) => s.metric === metric);
      const sum = series ? summarizeSeries(series) : undefined;
      const common = { hop: "container" as const, address, check, simulated: m.value.simulated };
      if (!sum) {
        out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `No ${metric} samples were returned for ${address}.`, data: { unavailable: m.value.unavailable.slice(0, 3) } }));
        continue;
      }
      const mean = toPercent(sum.recentMean, sum.unit);
      const peak = toPercent(sum.peak, sum.unit);
      if (mean === undefined || peak === undefined) {
        out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `${label} utilization of ${address} is reported in a unit this check does not understand (${sum.unit || "none"}).`, data: { unit: sum.unit } }));
        continue;
      }
      const high = mean >= SATURATED_PERCENT;
      out.push(
        ctx.evidence({
          ...common,
          outcome: high ? "fail" : "pass",
          finding: high ? `${label} utilization of ${address} averages ${round(mean)}% over its latest samples (peak ${round(peak)}%), at or above ${SATURATED_PERCENT}%.` : `${label} utilization of ${address} averages ${round(mean)}% (peak ${round(peak)}%), below ${SATURATED_PERCENT}%.`,
          data: { meanPercent: round(mean), peakPercent: round(peak), samples: sum.points, threshold: SATURATED_PERCENT },
        })
      );
    }
    return out;
  },
};
