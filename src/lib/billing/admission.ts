/**
 * Billing's say over NEW work (PROD-MAN-06). Called from `assertDispatchAdmitted` (src/lib/ops/admission.ts), which every
 * dispatch entry point already calls BEFORE it claims an approved operation, so a refusal here changes nothing.
 *
 * What a suspended or over-quota workspace loses: starting new provisioning-class work (deploy, day-two changes,
 * remediation, runner jobs). What it keeps, always: every read, the whole API surface that is not dispatch, running
 * workloads, data export (`export` dispatch and the tenant export route), and user-requested `destroy` (stopping spend is
 * never held hostage to a balance). Nothing is deleted; nothing Zenith owns is torn down because of billing.
 *
 * `billing: disabled` (the default, and every BYOC or self-hosted install) returns before ANY I/O: no store read, no
 * cache, no import of the store module.
 *
 * Unknown billing standing, assignment or quota refuses NEW work. Running workloads and data are never changed.
 */
import { billingConfigFromEnv, type Env } from "./config";
import { BackpressureError } from "@/lib/ops/errors";
import type { Sql } from "@/lib/controlplane/types";

/** Dispatch kinds billing never refuses. */
export const BILLING_EXEMPT_KINDS: ReadonlySet<string> = new Set(["export", "destroy"]);

export interface BillingAdmissionInput { workspaceId: string; kind: string; operationId?: string }

interface Snapshot { standing: "active" | "past_due" | "suspended"; reason?: string; planId?: string; at: number }

export interface BillingAdmissionOptions {
  env?: Env;
  store?: () => Promise<Sql>;
  now?: () => number;
  ttlMs?: number;
}

const USAGE_TTL_MS = 30_000;
const usageCache = new Map<string, { exceeded?: { meter: string; cap: number; used: number }; at: number }>();
const MAX_ENTRIES = 5_000;

/** Called by every standing change in this process so the next dispatch sees it. Standing is always read afresh; usage totals converge within their TTL. */
export function invalidateBillingState(workspaceId?: string): void {
  if (workspaceId) { for (const k of usageCache.keys()) if (k.startsWith(`${workspaceId}|`)) usageCache.delete(k); }
  else { usageCache.clear(); }
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MAX_ENTRIES) { const oldest = map.keys().next(); if (!oldest.done) map.delete(oldest.value); }
  map.delete(key);
  map.set(key, value);
}

async function defaultStore(): Promise<Sql> {
  const { opsRuntime } = await import("@/lib/ops/runtime");
  return opsRuntime().store();
}

export async function assertBillingAdmitted(input: BillingAdmissionInput, options: BillingAdmissionOptions = {}): Promise<void> {
  if (billingConfigFromEnv(options.env ?? process.env).mode !== "managed") return;
  if (BILLING_EXEMPT_KINDS.has(input.kind)) return;
  const now = options.now ?? Date.now;
  const getStore = options.store ?? defaultStore;
  const store = await import("./store");
  const plans = await import("./plans");

  // Re-read at every dispatch: neither a cached upgrade nor an outage may lift a restriction.
  let snap: Snapshot;
  try {
    const account = await store.getAccount(await getStore(), input.workspaceId);
    if (!account || !plans.isPlanId(account.planId) || !["active", "past_due", "suspended"].includes(account.status)) throw new Error("unknown assignment");
    snap = { standing: account.status, planId: account.planId, reason: account.suspensionReason, at: now() };
  } catch {
    throw new BackpressureError("billing_unavailable", "billing", "Billing standing or plan assignment is unknown. New work is refused; reads, running workloads, export and user-requested destroy remain available.", 30, input.workspaceId);
  }

  if (snap.standing === "suspended") {
    throw new BackpressureError(
      "billing_suspended", "billing",
      snap.reason === "operator"
        ? "New work is suspended on this workspace by a platform operator. Reads, running workloads and data export keep working; nothing was deleted."
        : "New work is suspended on this workspace because of an unpaid invoice. Reads, running workloads and data export keep working; nothing was deleted. Settling the invoice lifts the suspension.",
      3600, input.workspaceId
    );
  }

  const plan = plans.isPlanId(snap.planId) ? plans.getPlan(snap.planId) : plans.getPlan(plans.DEFAULT_PLAN_ID);
  // The plan's own cap on queued + running operations (the platform's OPS-02 quota applies independently).
  try {
    const sql = await getStore();
    const { activeOperationCount } = await import("@/lib/ops/store");
    const active = await activeOperationCount(sql, input.workspaceId, input.operationId);
    if (active >= plan.maxActiveOperations) {
      throw new BackpressureError("plan_quota_exceeded", "billing", `This workspace's plan (${plan.name}) allows ${plan.maxActiveOperations} operations at once and has ${active}. The operation was not claimed; retry when some finish.`, 30, input.workspaceId);
    }
    const exceeded = await hardCapExceeded(sql, input.workspaceId, plan, now, store);
    if (exceeded) {
      throw new BackpressureError("plan_quota_exceeded", "billing", `This workspace has used ${Math.round(exceeded.used)} of its plan's ${exceeded.cap} ${exceeded.meter.replaceAll("_", " ")} for this period (${plan.name}). New work is refused until the next period or a plan change; reads and export are unaffected.`, 3600, input.workspaceId);
    }
  } catch (error) {
    if (error instanceof BackpressureError) throw error;
    throw new BackpressureError("billing_unavailable", "billing", "Billing quota state is unavailable. New work is refused; reads, export and user-requested destroy remain available.", 30, input.workspaceId);
  }
}

async function hardCapExceeded(
  sql: Sql, workspaceId: string, plan: import("./plans").PlanDefinition, now: () => number, store: typeof import("./store")
): Promise<{ meter: string; cap: number; used: number } | undefined> {
  const capped = Object.entries(plan.meters).filter(([, a]) => a.hardCap !== undefined);
  if (!capped.length) return undefined;
  const { periodOf } = await import("./period");
  const period = periodOf(new Date(now()));
  const key = `${workspaceId}|${period}|${plan.id}`;
  const hit = usageCache.get(key);
  if (hit && now() - hit.at < USAGE_TTL_MS) return hit.exceeded;
  const totals = await store.aggregateUsage(sql, workspaceId, period);
  let exceeded: { meter: string; cap: number; used: number } | undefined;
  for (const [meter, allowance] of capped) {
    const used = totals.find((t) => t.meter === meter)?.quantity ?? 0;
    if (allowance.hardCap !== undefined && used >= allowance.hardCap) { exceeded = { meter, cap: allowance.hardCap, used }; break; }
  }
  remember(usageCache, key, { exceeded, at: now() });
  return exceeded;
}
