/**
 * The billing read model and the scheduled pass (PROD-MAN-06).
 *
 * `runBillingTick` is level-triggered and idempotent, so a late, repeated or overlapping pass converges: it re-derives usage
 * from durable records, invoices ended periods once, and re-derives every account's standing. In `billing: disabled` mode
 * it returns before touching the store.
 */
import type { Sql } from "@/lib/controlplane/types";
import { billingConfigFromEnv, type BillingConfig, type Env } from "./config";
import { generateInvoice } from "./invoice";
import { activePeriods, collectUsage } from "./metering";
import { periodBounds, periodOf } from "./period";
import { BILLABLE_METERS, DEFAULT_PLAN_ID, INFORMATIONAL_METERS, METER_UNITS, PLAN_NOTICE, getPlan, isPlanId, planView, type PlanView } from "./plans";
import type { InvoiceProvider } from "./provider";
import { runDunning } from "./standing";
import { StripeTestInvoiceProvider, type FetchLike } from "./stripe";
import { aggregateUsage, getAccount, listInvoices, listAccounts, type BillingAccount, type Invoice } from "./store";

/** A period is invoiced this long after it ends, so records that land a little late still count. */
export const INVOICE_SETTLE_MS = 6 * 3_600_000;

export function invoiceProviderFromEnv(env: Env = process.env, fetchImpl?: FetchLike): InvoiceProvider | undefined {
  const cfg = billingConfigFromEnv(env);
  if (cfg.mode !== "managed" || !cfg.stripe.secretKeyConfigured) return undefined;
  return new StripeTestInvoiceProvider({ secretKey: env.ZENITH_BILLING_STRIPE_SECRET_KEY!.trim(), apiBase: cfg.stripe.apiBase, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

export type BillingTickResult =
  | { enabled: false }
  | { enabled: true; accounts: number; usageRowsWritten: number; invoicesCreated: number; invoicesOpened: number; invoiceErrors: number; invoicing: string; dunning: { examined: number; changed: number; suspended: number } };

export async function runBillingTick(sql: Sql, deps: { env?: Env; provider?: InvoiceProvider; now: Date; config?: BillingConfig }): Promise<BillingTickResult> {
  const cfg = deps.config ?? billingConfigFromEnv(deps.env ?? process.env);
  if (cfg.mode !== "managed") return { enabled: false };
  const provider = deps.provider ?? invoiceProviderFromEnv(deps.env ?? process.env);
  const accounts = await listAccounts(sql, 1000);
  let usageRowsWritten = 0;
  let invoicesCreated = 0;
  let invoicesOpened = 0;
  let invoiceErrors = 0;
  const [previous, current] = activePeriods(deps.now);
  for (const account of accounts) {
    for (const period of [previous, current]) usageRowsWritten += (await collectUsage(sql, account.workspaceId, period, deps.now)).written;
    if (deps.now.getTime() >= periodBounds(previous).end.getTime() + INVOICE_SETTLE_MS) {
      const r = await generateInvoice(sql, { provider, now: deps.now, netDays: cfg.netDays }, account.workspaceId, previous);
      if (r.status === "ok") {
        if (r.created) invoicesCreated += 1;
        if (r.providerCalled && r.invoice.status === "open") invoicesOpened += 1;
        if (r.note === "provider_error") invoiceErrors += 1;
      }
    }
  }
  const dunning = await runDunning(sql, { graceDays: cfg.graceDays }, deps.now);
  return { enabled: true, accounts: accounts.length, usageRowsWritten, invoicesCreated, invoicesOpened, invoiceErrors, invoicing: provider?.kind ?? "not_configured", dunning };
}

/* -------------------------------- read model -------------------------------- */

export interface MeterView {
  meter: string;
  unit: string;
  used: number;
  included?: number;
  hardCap?: number;
  estimated: boolean;
  charged: boolean;
}

export interface BillingView {
  mode: "managed";
  provisional: true;
  notice: string;
  account: Pick<BillingAccount, "planId" | "status" | "suspensionReason" | "pastDueSince" | "suspendedAt"> | null;
  plan: PlanView;
  assigned: boolean;
  period: string;
  usage: MeterView[];
  invoices: Pick<Invoice, "id" | "period" | "status" | "subtotalCents" | "currency" | "dueAt" | "paidAt" | "planProvisional">[];
  whatSuspensionMeans: string;
}

export const SUSPENSION_MEANING = "Suspension only stops NEW provisioning work. Reads, running workloads, data export and user-requested destroy keep working, and Zenith never deletes anything because of billing.";

export async function billingView(sql: Sql, workspaceId: string, now: Date): Promise<BillingView> {
  const account = await getAccount(sql, workspaceId);
  const plan = getPlan(account && isPlanId(account.planId) ? account.planId : DEFAULT_PLAN_ID);
  const period = periodOf(now);
  const totals = await aggregateUsage(sql, workspaceId, period);
  const usage: MeterView[] = [
    ...BILLABLE_METERS.map((meter) => ({
      meter, unit: METER_UNITS[meter], used: totals.find((t) => t.meter === meter)?.quantity ?? 0,
      included: plan.meters[meter].included, ...(plan.meters[meter].hardCap !== undefined ? { hardCap: plan.meters[meter].hardCap } : {}), estimated: false, charged: true,
    })),
    ...INFORMATIONAL_METERS.map((meter) => ({ meter, unit: METER_UNITS[meter], used: totals.find((t) => t.meter === meter)?.quantity ?? 0, estimated: totals.find((t) => t.meter === meter)?.estimated ?? meter === "egress_gb_estimated", charged: false })),
  ];
  const invoices = (await listInvoices(sql, workspaceId, 12)).map((i) => ({ id: i.id, period: i.period, status: i.status, subtotalCents: i.subtotalCents, currency: i.currency, ...(i.dueAt ? { dueAt: i.dueAt } : {}), ...(i.paidAt ? { paidAt: i.paidAt } : {}), planProvisional: i.planProvisional }));
  return {
    mode: "managed", provisional: true, notice: PLAN_NOTICE,
    account: account ? { planId: account.planId, status: account.status, ...(account.suspensionReason ? { suspensionReason: account.suspensionReason } : {}), ...(account.pastDueSince ? { pastDueSince: account.pastDueSince } : {}), ...(account.suspendedAt ? { suspendedAt: account.suspendedAt } : {}) } : null,
    plan: planView(plan), assigned: Boolean(account), period, usage, invoices, whatSuspensionMeans: SUSPENSION_MEANING,
  };
}
