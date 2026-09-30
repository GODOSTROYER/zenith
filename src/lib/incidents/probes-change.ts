/**
 * Change and drift probes: what moved recently, and what no longer matches the
 * desired graph.
 *
 *   changes.recent              informational: was anything deployed/applied lately?
 *   changes.errors_after_deploy did known error signatures appear only after the latest rollout?
 *                               (emitted only when a rollout is within the lookback)
 *   drift.report                does the latest drift report show trouble on the path?
 *   drift.missing / drift.changed / drift.inaccessible / drift.unknown
 *                               one per drifted node ON the path
 *
 * `changes.recent` is `pass` even when a deployment is found: a deployment is
 * not itself a failure. What rules need is the fact, so it rides in `data`
 * (`recentDeployment: true|false`), and the bad-deploy rule reads it there.
 *
 * Honest limits: a deployment record names an operation, not a service, so
 * "errors after the deploy" is environment-wide (every service on the path).
 * Correlation needs a baseline: if the rollout precedes (or barely follows)
 * the start of the log window there is nothing to compare against, and the
 * check says `unknown` rather than call old errors new. A drift report for a
 * different graph revision, or older than the change window, is not used: the
 * report is `unknown` and its findings are left out rather than trusted.
 */
import type { DriftFinding } from "@/lib/resources/types";
import type { ProbeContext } from "./probe-context";
import type { GlobalProbe } from "./probe-types";
import { plural, round } from "./probe-util";
import { SIGNATURE_BY_ID } from "./signatures";
import { sanitizeText } from "./sanitize";
import type { RequestPath } from "./traverse";
import type { Evidence } from "./types";

const MIN_BASELINE_MS = 3 * 60_000;
const ROLLOUT_KIND = /^(?:deploy|deployment|apply|release|rollback|promote)/;

const summarizeChange = (c: { at: string; kind: string; summary: string; operationId?: string }) => ({ at: c.at, kind: c.kind, summary: c.summary, operationId: c.operationId ?? null });

/* --------------------------------- changes ---------------------------------- */

async function rollouts(ctx: ProbeContext) {
  const got = await ctx.changes();
  if (!got.ok) return got;
  const { changes, dropped } = got.value;
  const all = changes.filter((c) => ROLLOUT_KIND.test(c.kind));
  const since = ctx.nowMs - ctx.config.deploymentLookbackMs;
  const recent = all.filter((c) => Date.parse(c.at) >= since);
  return { ok: true as const, changes, dropped, all, recent, latest: recent[recent.length - 1] };
}

export const changesProbe: GlobalProbe = {
  id: "changes",
  hop: "deployment",
  checks: ["changes.recent"],
  async run(ctx: ProbeContext): Promise<Evidence[]> {
    const r = await rollouts(ctx);
    if (!r.ok) return [ctx.unknown("deployment", undefined, "changes.recent", r.message)];
    const { changes, dropped, all, recent, latest } = r;
    const hours = round(ctx.config.changeWindowMs / 3_600_000, 1);
    const minutes = Math.round(ctx.config.deploymentLookbackMs / 60_000);
    return [
      ctx.evidence({
        hop: "deployment",
        check: "changes.recent",
        outcome: "pass",
        finding: latest
          ? `${plural(recent.length, "deployment or apply")} in the last ${minutes} minutes; the latest was ${latest.kind} at ${latest.at}${latest.summary ? `: ${latest.summary}` : ""}.`
          : `No deployment, apply or rollback in the last ${minutes} minutes (${plural(changes.length, "change")} of any kind in ${hours} hours).`,
        data: {
          recentDeployment: latest !== undefined,
          rolloutsInWindow: all.length,
          changesInWindow: changes.length,
          droppedMalformed: dropped,
          ...(latest ? { latest: summarizeChange(latest), minutesAgo: round((ctx.nowMs - Date.parse(latest.at)) / 60_000, 0) } : {}),
          changes: changes.slice(-5).map(summarizeChange),
        },
      }),
    ];
  },
};

/**
 * Errors before vs after the latest rollout, over every service on the path.
 * Emits nothing when there was no recent rollout (there is nothing to correlate
 * with) or the changes could not be read (`changes.recent` already says so).
 */
export const deployProbe: GlobalProbe = {
  id: "deploy_correlation",
  hop: "deployment",
  checks: ["changes.errors_after_deploy"],
  async run(ctx: ProbeContext, path: RequestPath): Promise<Evidence[]> {
    const r = await rollouts(ctx);
    if (!r.ok || !r.latest) return [];
    const latest = r.latest;
    const services = [...new Set(path.steps.filter((s) => s.hop === "container").map((s) => s.address))].sort();
    const bundles = [];
    for (const a of services) bundles.push(await ctx.text(a)); // sequential: keeps the runner's concurrency bound honest
    const okBundles = bundles.flatMap((b) => (b.ok ? [b.value] : []));
    if (okBundles.length === 0)
      return [ctx.unknown("deployment", undefined, "changes.errors_after_deploy", services.length ? "no service's logs could be read" : "there is no service on the path")];

    const deployedMs = Date.parse(latest.at);
    const windowStart = ctx.nowMs - ctx.config.logWindowMs;
    const baselineMs = deployedMs - windowStart;
    const simulated = okBundles.some((b) => b.simulated);
    if (baselineMs < MIN_BASELINE_MS)
      return [
        ctx.evidence({
          hop: "deployment",
          check: "changes.errors_after_deploy",
          outcome: "unknown",
          finding: `The latest rollout (${latest.at}) is too close to the start of the ${Math.round(ctx.config.logWindowMs / 60_000)}-minute log window to compare errors before and after it.`,
          data: { deployedAt: latest.at, baselineMinutes: Math.max(0, round(baselineMs / 60_000)), comparable: false },
          simulated,
        }),
      ];

    let before = 0;
    let after = 0;
    const perSignature: Record<string, { before: number; after: number }> = {};
    for (const b of okBundles)
      for (const hit of b.hits) {
        if (hit.count < SIGNATURE_BY_ID[hit.signature].minCount) continue;
        const slot = (perSignature[hit.signature] ??= { before: 0, after: 0 });
        for (const t of hit.times) {
          if (t < deployedMs) {
            before += 1;
            slot.before += 1;
          } else {
            after += 1;
            slot.after += 1;
          }
        }
      }
    const beforeMin = baselineMs / 60_000;
    const afterMin = Math.max(1, (ctx.nowMs - deployedMs) / 60_000);
    const isNew = after > 0 && before === 0;
    const increased = before > 0 && after / afterMin >= 2 * (before / beforeMin) && after >= 3;
    const bad = isNew || increased;
    return [
      ctx.evidence({
        hop: "deployment",
        check: "changes.errors_after_deploy",
        outcome: bad ? "fail" : "pass",
        finding: bad
          ? `Known error signatures ${isNew ? "first appear" : "increase"} after the latest rollout at ${latest.at}: ${before} line${before === 1 ? "" : "s"} before, ${after} after.`
          : after === 0
            ? `No known error signature appeared after the latest rollout at ${latest.at} (${before} before it).`
            : `Error signatures after the latest rollout at ${latest.at} are not above their earlier rate (${before} before, ${after} after).`,
        data: { deployedAt: latest.at, deploymentKind: latest.kind, operationId: latest.operationId ?? null, before, after, newErrors: isNew, increased, comparable: true, baselineMinutes: round(beforeMin), afterMinutes: round(afterMin), errorKinds: perSignature },
        simulated,
      }),
    ];
  },
};

/* ---------------------------------- drift ----------------------------------- */

const ACTIONABLE: ReadonlySet<DriftFinding["class"]> = new Set(["missing", "changed"]);

export const driftProbe: GlobalProbe = {
  id: "drift",
  hop: "drift",
  checks: ["drift.report"],
  async run(ctx: ProbeContext, path: RequestPath): Promise<Evidence[]> {
    const got = await ctx.drift();
    if (!got.ok) return [ctx.unknown("drift", undefined, "drift.report", got.message)];
    const report = got.value;
    if (report === null) return [ctx.unknown("drift", undefined, "drift.report", "no drift report has been computed for this environment yet")];

    const ageMs = ctx.nowMs - Date.parse(report.computedAt);
    const common = { hop: "drift" as const, check: "drift.report", simulated: report.simulated === true, observedAt: report.computedAt };
    if (report.graphDigest !== ctx.graph.graphDigest)
      return [ctx.evidence({ ...common, outcome: "unknown", finding: "The drift report was computed against a different revision of the desired graph, so its findings were not used.", data: { reportDigest: sanitizeText(report.graphDigest, 80), graphDigest: ctx.graph.graphDigest } })];
    if (Number.isNaN(ageMs) || ageMs > ctx.config.changeWindowMs)
      return [ctx.evidence({ ...common, outcome: "unknown", finding: `The latest drift report is ${Number.isNaN(ageMs) ? "of unknown age" : `${round(ageMs / 3_600_000, 1)} hours old`}, too old to say what the environment looks like now.`, data: { computedAt: sanitizeText(report.computedAt, 40) } })];

    const onPath = new Map(path.steps.map((s) => [s.address, s]));
    const findings = (report.findings ?? []).filter((f) => onPath.has(f.address)).sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.class < b.class ? -1 : a.class > b.class ? 1 : 0));
    const unobserved = (report.unobserved ?? []).filter((a) => onPath.has(a)).sort();
    const actionable = findings.filter((f) => ACTIONABLE.has(f.class));

    const out: Evidence[] = [
      ctx.evidence({
        ...common,
        outcome: actionable.length > 0 ? "fail" : unobserved.length > 0 ? "unknown" : "pass",
        finding:
          actionable.length > 0
            ? `Drift on the request path: ${actionable.map((f) => `${f.address} ${f.class}`).join("; ")}.`
            : unobserved.length > 0
              ? `No drift was found on the path, but ${plural(unobserved.length, "node")} could not be observed: ${unobserved.slice(0, 5).join(", ")}.`
              : "The drift report shows no drift on the request path.",
        data: { findingsOnPath: findings.length, actionable: actionable.length, unobserved: unobserved.slice(0, 10), computedAt: report.computedAt },
      }),
    ];
    for (const f of findings) {
      if (f.class === "extra") continue;
      const step = onPath.get(f.address)!;
      const node = ctx.node(f.address);
      out.push(
        ctx.evidence({
          hop: "drift",
          address: f.address,
          check: `drift.${f.class}`,
          outcome: ACTIONABLE.has(f.class) ? "fail" : "unknown",
          finding: `Drift: ${f.explanation}`,
          observedAt: report.computedAt,
          simulated: report.simulated === true,
          data: {
            nodeKind: node?.kind ?? null,
            ownership: node?.ownership ?? null,
            severity: f.severity,
            repairable: f.repairable,
            autoRepairEligible: f.autoRepairEligible,
            ...(step.dependency ? { protects: step.dependency.class, dependency: step.dependency.address } : {}),
            ...(f.fields ? { fields: f.fields.slice(0, 6) } : {}),
          },
        })
      );
    }
    return out;
  },
};
