/**
 * The operator report: every SLI against its target (PROD-OPS-01).
 *
 * Used by `GET /api/admin/ops/slo` and the `/admin/slo` page. Every objective carries the label of its definitions:
 * "Approved launch target, not a contractual SLA" when the owner approved them (DEC-BUSINESS), otherwise
 * "Provisional, not approved"; nothing here can produce wording that presents a target as a contractual commitment.
 * Control-plane availability is read from two sources (customer requests and an external probe) and reports the
 * LOWER ratio when both report; without probe data it says so. States are honest about missing evidence:
 *   ratio objectives      meeting | breaching | no_data
 *   measured objectives   met | missed | not_measured   (RPO, RTO and capacity are only "met" after a recorded
 *                                                        rehearsal or test; no measurement is never a pass)
 *   any objective whose query failed reports `unavailable` instead of being dropped.
 */
import type { Sql } from "@/lib/controlplane/types";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { budgetState, evaluateBurnAlerts, ratioStatus, readWindow, WINDOWS_NEEDED, type BudgetState, type BurnAlertState, type WindowReading } from "./budget";
import { isRatioObjective, sloDefinitions, sloLabel, type Approval, type CapacityObjective, type NextMilestone, type Objective, type ObjectiveStatus, type RatioLike, type RecoveryObjective } from "./definitions";
import { capacityMeetsTarget } from "./recovery";
import { flushSloSamples, SLI_API_AVAILABILITY, SLI_API_LATENCY, SLI_EXTERNAL_PROBE, SLI_MANAGED_RUNTIME, SLI_MANAGED_RUNTIME_UNKNOWN, SLI_SCHEDULER_HEALTH } from "./recorder";
import { apiLatencyQuantileFromSnapshot, ratioOf, type GoodTotal } from "./sli";
import { dispatchLatencyWindows, listMeasurements, sampleWindows, workflowCompletionWindows, type Measurement, type WindowKey } from "./store";

export type ObjectiveState = "meeting" | "breaching" | "no_data" | "met" | "missed" | "not_measured" | "unavailable";

export interface ObjectiveReport {
  id: string;
  title: string;
  category: string;
  kind: Objective["kind"];
  /** "target" when the definitions are approved launch targets, otherwise "provisional" */
  status: ObjectiveStatus;
  /** the definitions' label (never wording that implies a contractual SLA) */
  label: string;
  sli: string;
  /** human wording of the target, e.g. "99.5% of requests" or "at most 900 s" */
  targetText: string;
  state: ObjectiveState;
  /** ratio objectives: the SLI over the budget window; measured objectives: the latest measured value; else null */
  current: number | null;
  windows?: WindowReading[];
  budget?: BudgetState;
  alerts?: BurnAlertState[];
  measurements?: Measurement[];
  /** this process's own p95 estimate in seconds (api latency only); not the budget basis */
  processP95Seconds?: number | null;
  note?: string;
  /** control-plane availability only: the two measurement sources and which one the reported value follows */
  sources?: AvailabilitySources;
}

export interface SourceReading { good: number; total: number; current: number | null }
export interface AvailabilitySources {
  requestBased: SourceReading;
  externalProbe: SourceReading;
  /** whether any external probe sample exists in the budget window */
  probeReporting: boolean;
  basis: "lower_of_request_and_probe" | "request_based_only";
  /** present exactly when the probe is not reporting */
  notice?: string;
}

export const PROBE_NOT_REPORTING_NOTICE = "External probe not reporting; request-based measurement cannot see outages that stop requests arriving.";

export interface SloReport {
  generatedAt: string;
  definitionVersion: string;
  label: string;
  approval: Approval;
  /** true when the owner approved these as launch engineering targets (never a contractual SLA) */
  approved: boolean;
  budgetWindowDays: number;
  /** a stated aspiration; never evaluated as a target */
  nextMilestone?: NextMilestone;
  objectives: ObjectiveReport[];
  burning: string[];
  restoreMilestones?: { database: Measurement[]; application: Measurement[] };
}

const pct = (x: number): string => `${Math.round(x * 100_000) / 1000}%`;

function targetText(o: Objective): string {
  switch (o.kind) {
    case "ratio": return `${pct(o.target)} good events`;
    case "latency_ratio": return `${pct(o.target)} of events within ${o.thresholdSeconds >= 1 ? `${o.thresholdSeconds} s` : `${Math.round(o.thresholdSeconds * 1000)} ms`}`;
    case "capacity": return `at least ${o.minRequestsPerSecond} requests/s with p95 at most ${o.maxP95Ms} ms and errors at most ${pct(o.maxErrorRate)}`;
    default: return `at most ${o.maxSeconds} s`;
  }
}

const WINDOW_KEYS: readonly WindowKey[] = [...WINDOWS_NEEDED, "budget"];

/** The lower of the two availability sources, window by window; a source with no events in a window is not consulted. */
export function lowerOfSources(requests: Record<WindowKey, GoodTotal>, probe: Record<WindowKey, GoodTotal>): Record<WindowKey, GoodTotal> {
  const out = {} as Record<WindowKey, GoodTotal>;
  for (const k of WINDOW_KEYS) {
    const r = ratioOf(requests[k]);
    const p = ratioOf(probe[k]);
    out[k] = p === null ? requests[k] : r === null ? probe[k] : p < r ? probe[k] : requests[k];
  }
  return out;
}

const reading = (g: GoodTotal): SourceReading => ({ good: g.good, total: g.total, current: ratioOf(g) });

async function ratioWindows(sql: Sql, o: RatioLike, budgetDays: number): Promise<Record<WindowKey, GoodTotal>> {
  switch (o.id) {
    case "control_plane_availability": return sampleWindows(sql, SLI_API_AVAILABILITY, budgetDays);
    case "managed_runtime_availability": return sampleWindows(sql, SLI_MANAGED_RUNTIME, budgetDays);
    case "api_latency": return sampleWindows(sql, SLI_API_LATENCY, budgetDays);
    case "scheduler_health": return sampleWindows(sql, SLI_SCHEDULER_HEALTH, budgetDays);
    case "workflow_completion": return workflowCompletionWindows(sql, budgetDays);
    case "dispatch_latency": return dispatchLatencyWindows(sql, o.kind === "latency_ratio" ? o.thresholdSeconds : 30, budgetDays);
    default: throw new Error(`No indicator source for objective ${o.id}.`);
  }
}

async function ratioReport(sql: Sql, o: RatioLike, base: Omit<ObjectiveReport, "state" | "current">, budgetDays: number, alerts: ReturnType<typeof sloDefinitions>["burnAlerts"]): Promise<ObjectiveReport> {
  let w = await ratioWindows(sql, o, budgetDays);
  let sources: AvailabilitySources | undefined;
  let note: string | undefined;
  if (o.id === "control_plane_availability") {
    const probe = await sampleWindows(sql, SLI_EXTERNAL_PROBE, budgetDays);
    const probeReporting = probe.budget.total > 0;
    sources = {
      requestBased: reading(w.budget), externalProbe: reading(probe.budget), probeReporting,
      basis: probeReporting ? "lower_of_request_and_probe" : "request_based_only",
      ...(probeReporting ? {} : { notice: PROBE_NOT_REPORTING_NOTICE }),
    };
    if (probeReporting) w = lowerOfSources(w, probe);
    else note = PROBE_NOT_REPORTING_NOTICE;
  } else if (o.id === "managed_runtime_availability") {
    const unknown = (await sampleWindows(sql, SLI_MANAGED_RUNTIME_UNKNOWN, budgetDays)).budget.total;
    note = unknown > 0 ? `${unknown} observation${unknown === 1 ? "" : "s"} of unknown health in this window were left out of the ratio.` : undefined;
  }
  const readings: WindowReading[] = [...WINDOWS_NEEDED, "budget" as const].map((k) => readWindow(o, k, w[k]));
  const budget = w.budget;
  const processP95 = o.id === "api_latency" ? apiLatencyQuantileFromSnapshot(metricsRegistry().snapshot(), 0.95) : undefined;
  return {
    ...base,
    state: ratioStatus(o, budget),
    current: budget.total > 0 ? budget.good / budget.total : null,
    windows: readings,
    budget: budgetState(o, budget),
    alerts: evaluateBurnAlerts(o, alerts, w),
    ...(sources ? { sources } : {}),
    ...(note ? { note } : {}),
    ...(processP95 !== undefined ? { processP95Seconds: Number.isFinite(processP95 ?? 0) ? processP95 : null } : {}),
  };
}

async function measuredReport(sql: Sql, o: RecoveryObjective | CapacityObjective, base: Omit<ObjectiveReport, "state" | "current">): Promise<ObjectiveReport> {
  const kind = o.kind === "capacity" ? "capacity" : o.id === "rpo" ? "rpo" : "rto";
  const measurements = await listMeasurements(sql, kind, 5);
  const latest = measurements[0];
  if (!latest) return { ...base, state: "not_measured", current: null, measurements, note: kind === "capacity" ? "No capacity test has been recorded. Run scripts/slo/capacity-test.mjs with --report." : "No restore rehearsal has reported a measurement yet." };
  // Judge against the CURRENT target, not the flag stored when the target was different.
  const met = o.kind === "capacity"
    ? capacityMeetsTarget({ sustainedRps: latest.value, p95Ms: Number(latest.details.p95Ms), errorRate: Number(latest.details.errorRate) }, o)
    : latest.value <= o.maxSeconds;
  return { ...base, state: met ? "met" : "missed", current: latest.value, measurements };
}

export async function buildSloReport(sql: Sql): Promise<SloReport> {
  const defs = sloDefinitions();
  await flushSloSamples(sql);
  const objectives: ObjectiveReport[] = [];
  for (const o of defs.objectives) {
    const base = { id: o.id, title: o.title, category: o.category, kind: o.kind, status: o.status, label: sloLabel(defs), sli: o.sli, targetText: targetText(o) };
    try {
      objectives.push(isRatioObjective(o) ? await ratioReport(sql, o, base, defs.budgetWindowDays, defs.burnAlerts) : await measuredReport(sql, o, base));
    } catch {
      objectives.push({ ...base, state: "unavailable", current: null, note: "This indicator could not be read from the control store." });
    }
  }
  const burning = objectives.filter((r) => r.alerts?.some((a) => a.firing)).map((r) => r.id);
  const restoreMilestones = { database: await listMeasurements(sql, "database_restore", 5), application: await listMeasurements(sql, "application_health", 5) };
  return { restoreMilestones, generatedAt: new Date().toISOString(), definitionVersion: defs.definitionVersion, label: sloLabel(defs), approval: defs.approval, approved: defs.approval.status === "approved_targets", budgetWindowDays: defs.budgetWindowDays, ...(defs.nextMilestone ? { nextMilestone: defs.nextMilestone } : {}), objectives, burning };
}
