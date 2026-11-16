/**
 * Error budgets and multiwindow burn-rate evaluation (PROD-OPS-01). Pure.
 *
 * For a ratio objective with target T the error budget fraction is 1 - T. The burn rate over a window is
 * (observed error ratio) / (1 - T): 1.0 spends exactly the whole budget over the budget window, 14.4 spends 2% of a
 * 30-day budget in one hour. A burn alert fires only when BOTH its long and short windows burn at or above its factor
 * (the short window stops an alert from lingering after recovery). This mirrors the Prometheus rules in
 * deploy/observability/alerts/zenith-slo.rules.json; tests/slo/slo-artifacts.test.ts keeps the two in step.
 */
import { BURN_WINDOW_SECONDS, errorBudgetFraction, type BurnAlertDef, type BurnWindow, type RatioLike } from "./definitions";
import type { GoodTotal } from "./sli";

/** A window with fewer events than this is "no data" for alerting, so one failed request at 3am cannot page. */
export const MIN_EVENTS_FOR_ALERT = 20;

export type WindowCounts = Readonly<Partial<Record<BurnWindow | "budget", GoodTotal>>>;

export interface WindowReading { window: BurnWindow | "budget"; good: number; total: number; sli: number | null; burnRate: number | null }

export function burnRate(objective: RatioLike, counts: GoodTotal): number | null {
  if (counts.total <= 0) return null;
  const errorRatio = (counts.total - counts.good) / counts.total;
  const budget = errorBudgetFraction(objective);
  return budget > 0 ? errorRatio / budget : null;
}

export function readWindow(objective: RatioLike, window: BurnWindow | "budget", counts: GoodTotal | undefined): WindowReading {
  const c = counts ?? { good: 0, total: 0 };
  return { window, good: c.good, total: c.total, sli: c.total > 0 ? c.good / c.total : null, burnRate: burnRate(objective, c) };
}

export interface BudgetState {
  /** fraction of the budget window's error budget still unspent; negative when overspent; null with no data */
  remainingFraction: number | null;
  /** events allowed to fail in the observed total, and how many did */
  allowedBad: number | null;
  actualBad: number;
}

export function budgetState(objective: RatioLike, counts: GoodTotal | undefined): BudgetState {
  const c = counts ?? { good: 0, total: 0 };
  const actualBad = c.total - c.good;
  if (c.total <= 0) return { remainingFraction: null, allowedBad: null, actualBad };
  const allowedBad = c.total * errorBudgetFraction(objective);
  return { remainingFraction: allowedBad > 0 ? 1 - actualBad / allowedBad : null, allowedBad, actualBad };
}

export interface BurnAlertState { name: string; severity: BurnAlertDef["severity"]; factor: number; longWindow: BurnWindow; shortWindow: BurnWindow; longBurn: number | null; shortBurn: number | null; firing: boolean }

export function evaluateBurnAlerts(objective: RatioLike, alerts: readonly BurnAlertDef[], counts: WindowCounts): BurnAlertState[] {
  return alerts.map((a) => {
    const long = counts[a.longWindow] ?? { good: 0, total: 0 };
    const short = counts[a.shortWindow] ?? { good: 0, total: 0 };
    const longBurn = burnRate(objective, long);
    const shortBurn = burnRate(objective, short);
    const enoughData = long.total >= MIN_EVENTS_FOR_ALERT && short.total > 0;
    const firing = enoughData && longBurn !== null && shortBurn !== null && longBurn >= a.factor && shortBurn >= a.factor;
    return { name: a.name, severity: a.severity, factor: a.factor, longWindow: a.longWindow, shortWindow: a.shortWindow, longBurn, shortBurn, firing };
  });
}

export const WINDOWS_NEEDED: readonly BurnWindow[] = Object.keys(BURN_WINDOW_SECONDS) as BurnWindow[];

export type RatioStatus = "meeting" | "breaching" | "no_data";
export function ratioStatus(objective: RatioLike, budgetWindow: GoodTotal | undefined): RatioStatus {
  if (!budgetWindow || budgetWindow.total <= 0) return "no_data";
  return budgetWindow.good / budgetWindow.total >= objective.target ? "meeting" : "breaching";
}
