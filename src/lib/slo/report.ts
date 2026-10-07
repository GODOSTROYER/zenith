/**
 * The operator report: every SLI against its provisional target (PROD-OPS-01).
 *
 * Used by `GET /api/admin/ops/slo` and the `/admin/slo` page. Every objective carries the label
 * "Provisional, not approved" and the report states that the targets await DEC-BUSINESS; nothing here can
 * produce wording that presents a target as a commitment. States are honest about missing evidence:
 *   ratio objectives      meeting | breaching | no_data
 *   measured objectives   met | missed | not_measured   (RPO, RTO and capacity are only "met" after a recorded
 *                                                        rehearsal or test; no measurement is never a pass)
 *   any objective whose query failed reports `unavailable` instead of being dropped.
 */
import type { Sql } from "@/lib/controlplane/types";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { budgetState, evaluateBurnAlerts, ratioStatus, readWindow, WINDOWS_NEEDED, type BudgetState, type BurnAlertState, type WindowReading } from "./budget";
import { isRatioObjective, PROVISIONAL_LABEL, sloDefinitions, type CapacityObjective, type Objective, type RatioLike, type RecoveryObjective } from "./definitions";
import { capacityMeetsTarget } from "./recovery";
import { flushSloSamples, SLI_API_AVAILABILITY, SLI_API_LATENCY, SLI_SCHEDULER_HEALTH } from "./recorder";
import { apiLatencyQuantileFromSnapshot, type GoodTotal } from "./sli";
import { dispatchLatencyWindows, listMeasurements, sampleWindows, workflowCompletionWindows, type Measurement, type WindowKey } from "./store";

export type ObjectiveState = "meeting" | "breaching" | "no_data" | "met" | "missed" | "not_measured" | "unavailable";

export interface ObjectiveReport {
  id: string;
  title: string;
  category: string;
  kind: Objective["kind"];
  /** always "provisional" */
  status: "provisional";
  /** always PROVISIONAL_LABEL */
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
}

export interface SloReport {
  generatedAt: string;
  definitionVersion: string;
  label: string;
  approval: { status: "not_approved"; pendingDecision: "DEC-BUSINESS"; note: string };
  budgetWindowDays: number;
  objectives: ObjectiveReport[];
  burning: string[];
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

async function ratioWindows(sql: Sql, o: RatioLike, budgetDays: number): Promise<Record<WindowKey, GoodTotal>> {
  switch (o.id) {
    case "control_plane_availability": return sampleWindows(sql, SLI_API_AVAILABILITY, budgetDays);
    case "api_latency": return sampleWindows(sql, SLI_API_LATENCY, budgetDays);
    case "scheduler_health": return sampleWindows(sql, SLI_SCHEDULER_HEALTH, budgetDays);
    case "workflow_completion": return workflowCompletionWindows(sql, budgetDays);
    case "dispatch_latency": return dispatchLatencyWindows(sql, o.kind === "latency_ratio" ? o.thresholdSeconds : 30, budgetDays);
    default: throw new Error(`No indicator source for objective ${o.id}.`);
  }
}

async function ratioReport(sql: Sql, o: RatioLike, base: Omit<ObjectiveReport, "state" | "current">, budgetDays: number, alerts: ReturnType<typeof sloDefinitions>["burnAlerts"]): Promise<ObjectiveReport> {
  const w = await ratioWindows(sql, o, budgetDays);
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
    ...(processP95 !== undefined ? { processP95Seconds: Number.isFinite(processP95 ?? 0) ? processP95 : null } : {}),
  };
}

async function measuredReport(sql: Sql, o: RecoveryObjective | CapacityObjective, base: Omit<ObjectiveReport, "state" | "current">): Promise<ObjectiveReport> {
  const kind = o.kind === "capacity" ? "capacity" : o.id === "rpo" ? "rpo" : "rto";
  const measurements = await listMeasurements(sql, kind, 5);
  const latest = measurements[0];
  if (!latest) return { ...base, state: "not_measured", current: null, measurements, note: kind === "capacity" ? "No capacity test has been recorded. Run scripts/slo/capacity-test.mjs with --report." : "No restore rehearsal has reported a measurement yet." };
  // Judge against the CURRENT provisional target, not the flag stored when the target was different.
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
    const base = { id: o.id, title: o.title, category: o.category, kind: o.kind, status: "provisional" as const, label: PROVISIONAL_LABEL, sli: o.sli, targetText: targetText(o) };
    try {
      objectives.push(isRatioObjective(o) ? await ratioReport(sql, o, base, defs.budgetWindowDays, defs.burnAlerts) : await measuredReport(sql, o, base));
    } catch {
      objectives.push({ ...base, state: "unavailable", current: null, note: "This indicator could not be read from the control store." });
    }
  }
  const burning = objectives.filter((r) => r.alerts?.some((a) => a.firing)).map((r) => r.id);
  return { generatedAt: new Date().toISOString(), definitionVersion: defs.definitionVersion, label: PROVISIONAL_LABEL, approval: defs.approval, budgetWindowDays: defs.budgetWindowDays, objectives, burning };
}
