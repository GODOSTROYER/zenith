/**
 * Dunning and safe suspension (PROD-MAN-06).
 *
 * Standing is DERIVED from durable invoices every time it is evaluated (level-triggered and idempotent), then recorded on
 * the account:
 *
 *   no unpaid invoice that failed or is overdue         -> active
 *   one or more, grace not yet over                     -> past_due   (notice only; nothing is refused)
 *   oldest due date + grace days has passed             -> suspended  (reason: nonpayment)
 *
 * `suspended` has exactly one effect: `assertBillingAdmitted` refuses NEW dispatch. It never deletes, stops, tears down or
 * hides anything. A suspended workspace still reads every record, its workloads keep running, it can export all of its
 * data and it can destroy what it chose to. This module holds no delete path at all and the tables refuse deletion.
 *
 * An operator suspension (reason: operator) is never lifted automatically by a payment; only an operator reinstates it.
 * A payment lifts a nonpayment suspension as soon as no failed or overdue invoice remains.
 */
import type { Sql } from "@/lib/controlplane/types";
import { invalidateBillingState } from "./admission";
import { applyStanding, getAccount, listStandingCandidates, unpaidInvoices, type AccountEventKind, type BillingAccount, type Standing } from "./store";

export interface StandingConfig { graceDays: number }
const DAY_MS = 86_400_000;
const SYSTEM = "system:billing";

export interface StandingResult { workspaceId: string; status: Standing; changed: boolean; suspendAfter?: string }

export async function reconcileStanding(sql: Sql, workspaceId: string, cfg: StandingConfig, now: Date, actor = SYSTEM): Promise<StandingResult | null> {
  const account = await getAccount(sql, workspaceId);
  if (!account) return null;
  if (account.status === "suspended" && account.suspensionReason === "operator") return { workspaceId, status: "suspended", changed: false };

  const nowMs = now.getTime();
  const relevant = (await unpaidInvoices(sql, workspaceId)).filter((i) => i.status === "failed" || new Date(i.dueAt).getTime() <= nowMs);
  if (relevant.length === 0) {
    if (account.status === "active") return { workspaceId, status: "active", changed: false };
    const kind: AccountEventKind = account.status === "suspended" ? "reinstated" : "payment_received";
    const r = await applyStanding(sql, { workspaceId, target: { status: "active" }, actor, eventKind: kind, reason: "no unpaid invoice remains", now });
    invalidateBillingState(workspaceId);
    return { workspaceId, status: "active", changed: Boolean(r?.changed) };
  }

  const oldestDue = new Date(Math.min(...relevant.map((i) => new Date(i.dueAt).getTime())));
  const suspendAfter = new Date(oldestDue.getTime() + cfg.graceDays * DAY_MS);
  const toSuspended = nowMs >= suspendAfter.getTime();
  const target = toSuspended
    ? { status: "suspended" as const, suspensionReason: "nonpayment" as const, pastDueSince: oldestDue }
    : { status: "past_due" as const, pastDueSince: oldestDue };
  const kind: AccountEventKind = toSuspended ? "suspended" : account.status === "suspended" ? "reinstated" : "past_due";
  const r = await applyStanding(sql, {
    workspaceId, target, actor, eventKind: kind, now,
    reason: toSuspended ? `invoice unpaid past the ${cfg.graceDays}-day grace period` : "an invoice failed or is overdue",
  });
  invalidateBillingState(workspaceId);
  return { workspaceId, status: target.status, changed: Boolean(r?.changed), suspendAfter: suspendAfter.toISOString() };
}

/** The scheduled dunning pass over every account that might need to move. Bounded; each account is its own transaction. */
export async function runDunning(sql: Sql, cfg: StandingConfig, now: Date): Promise<{ examined: number; changed: number; suspended: number }> {
  let changed = 0;
  let suspended = 0;
  const candidates = await listStandingCandidates(sql, now);
  for (const workspaceId of candidates) {
    const r = await reconcileStanding(sql, workspaceId, cfg, now);
    if (r?.changed) changed += 1;
    if (r?.changed && r.status === "suspended") suspended += 1;
  }
  return { examined: candidates.length, changed, suspended };
}

/** Operator-initiated suspension of NEW work. Reversible, audited, deletes nothing. */
export async function suspendWorkspace(sql: Sql, input: { workspaceId: string; actor: string; reason: string; now: Date }): Promise<BillingAccount | null> {
  const r = await applyStanding(sql, { workspaceId: input.workspaceId, target: { status: "suspended", suspensionReason: "operator", pastDueSince: null }, actor: input.actor, eventKind: "suspended", reason: input.reason, now: input.now });
  invalidateBillingState(input.workspaceId);
  return r?.account ?? null;
}

/** Operator reinstatement. If an invoice is still unpaid past grace, the next dunning pass will say so again; that is the honest state. */
export async function reinstateWorkspace(sql: Sql, input: { workspaceId: string; actor: string; reason: string; now: Date }): Promise<BillingAccount | null> {
  const r = await applyStanding(sql, { workspaceId: input.workspaceId, target: { status: "active" }, actor: input.actor, eventKind: "reinstated", reason: input.reason, now: input.now });
  invalidateBillingState(input.workspaceId);
  return r?.account ?? null;
}
