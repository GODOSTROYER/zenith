/**
 * Pricing a period and generating its invoice (PROD-MAN-06).
 *
 * `priceInvoice` is pure: the plan, the aggregated usage and nothing else. `generateInvoice` is the effectful wrapper and
 * is safe to repeat at any point:
 *
 *   1. the period must have ended (an open period is never invoiced);
 *   2. usage is collected one last time (idempotent; a no-op once the period is closed);
 *   3. ONE invoice row per (workspace, period) is inserted as `draft` carrying the exact lines, total and digest it will be
 *      sent with. A second call finds that row and never reprices it;
 *   4. the provider invoice is created with idempotency keys derived from the row id, so a crash between the provider
 *      call and the status update is repaired by the next attempt returning the same provider invoice;
 *   5. a zero total is `no_charge` and never reaches the provider.
 *
 * Estimated meters (COST egress) and informational meters are listed with a zero amount and are never charged.
 */
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { collectUsage } from "./metering";
import { periodEnded } from "./period";
import { BILLABLE_METERS, METER_UNITS, getPlan, isPlanId, type PlanDefinition } from "./plans";
import type { InvoiceProvider } from "./provider";
import { BillingProviderError } from "./provider";
import {
  aggregateUsage, getAccount, getInvoiceByPeriod, insertDraftInvoice, markInvoiceNoCharge, markInvoiceOpen, recordInvoiceError, setStripeCustomer,
  type Invoice, type InvoiceLine, type UsageTotal,
} from "./store";

export interface PricedInvoice { lines: InvoiceLine[]; subtotalCents: number; digest: string }

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function priceInvoice(plan: PlanDefinition, totals: readonly UsageTotal[], period: string): PricedInvoice {
  const lines: InvoiceLine[] = [];
  if (plan.baseCents > 0) lines.push({ key: "base", description: `${plan.name} base fee`, quantity: 1, unit: "period", unitCents: plan.baseCents, amountCents: plan.baseCents });
  for (const meter of BILLABLE_METERS) {
    const total = totals.find((t) => t.meter === meter);
    const quantity = round6(total?.quantity ?? 0);
    if (quantity <= 0) continue;
    const allowance = plan.meters[meter];
    const billable = Math.max(0, quantity - allowance.included);
    const amountCents = Math.round(billable * allowance.rateCents);
    lines.push({
      key: meter,
      description: `${meter.replaceAll("_", " ")}: ${quantity} ${METER_UNITS[meter]} used, ${allowance.included} included`,
      quantity: round6(billable), unit: METER_UNITS[meter], unitCents: allowance.rateCents, amountCents,
    });
  }
  for (const t of totals) {
    if (BILLABLE_METERS.includes(t.meter as (typeof BILLABLE_METERS)[number])) continue;
    lines.push({ key: t.meter, description: `${t.meter.replaceAll("_", " ")}${t.estimated ? " (estimate, not charged)" : " (not charged)"}`, quantity: round6(t.quantity), unit: METER_UNITS[t.meter], unitCents: 0, amountCents: 0 });
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  return { lines, subtotalCents, digest: digest({ kind: "zenith.invoice.v1", plan: plan.id, period, lines, subtotalCents }) };
}

export interface GenerateInvoiceDeps {
  provider?: InvoiceProvider;
  now: Date;
  netDays: number;
}

export type GenerateInvoiceResult =
  | { status: "not_ready"; reason: "period_open" | "no_account" | "unknown_plan" }
  | { status: "ok"; invoice: Invoice; created: boolean; providerCalled: boolean; note?: "provider_not_configured" | "provider_error" };

export async function generateInvoice(sql: Sql, deps: GenerateInvoiceDeps, workspaceId: string, period: string): Promise<GenerateInvoiceResult> {
  if (!periodEnded(period, deps.now)) return { status: "not_ready", reason: "period_open" };
  const account = await getAccount(sql, workspaceId);
  if (!account) return { status: "not_ready", reason: "no_account" };
  if (!isPlanId(account.planId)) return { status: "not_ready", reason: "unknown_plan" };

  let invoice = await getInvoiceByPeriod(sql, workspaceId, period);
  let created = false;
  if (!invoice) {
    await collectUsage(sql, workspaceId, period, deps.now);
    const plan = getPlan(account.planId);
    const priced = priceInvoice(plan, await aggregateUsage(sql, workspaceId, period), period);
    const dueAt = new Date(deps.now.getTime() + deps.netDays * 86_400_000);
    ({ invoice, created } = await insertDraftInvoice(sql, { workspaceId, period, planId: plan.id, planProvisional: plan.provisional, ...priced, dueAt }));
  }
  if (invoice.status !== "draft") return { status: "ok", invoice, created, providerCalled: false };

  if (invoice.subtotalCents === 0) {
    const closed = await markInvoiceNoCharge(sql, workspaceId, invoice.id);
    return { status: "ok", invoice: closed ?? invoice, created, providerCalled: false };
  }
  if (!deps.provider) return { status: "ok", invoice, created, providerCalled: false, note: "provider_not_configured" };

  try {
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      customerId = (await deps.provider.ensureCustomer({ workspaceId, idempotencyKey: `zenith-customer-${workspaceId}` })).customerId;
      await setStripeCustomer(sql, workspaceId, customerId);
    }
    const { providerInvoiceId } = await deps.provider.createInvoice({
      invoiceId: invoice.id, workspaceId, customerId, period, lines: invoice.lines, currency: "usd",
      dueDays: Math.max(1, Math.ceil(((invoice.dueAt ? new Date(invoice.dueAt).getTime() : deps.now.getTime()) - deps.now.getTime()) / 86_400_000)),
      idempotencyKey: `zenith-invoice-${invoice.id}`,
    });
    const open = await markInvoiceOpen(sql, workspaceId, invoice.id, { stripeInvoiceId: providerInvoiceId, stripeCustomerId: customerId });
    return { status: "ok", invoice: open ?? (await getInvoiceByPeriod(sql, workspaceId, period)) ?? invoice, created, providerCalled: true };
  } catch (error) {
    // The invoice stays `draft` with its exact lines; the next pass retries with the same idempotency keys.
    const message = error instanceof BillingProviderError ? `${error.code}: ${error.message}` : "provider_error";
    const recorded = await recordInvoiceError(sql, workspaceId, invoice.id, message).catch(() => null);
    return { status: "ok", invoice: recorded ?? invoice, created, providerCalled: true, note: "provider_error" };
  }
}
