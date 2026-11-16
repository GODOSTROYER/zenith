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
 *   5. a zero total is `no_charge` and never reaches the provider;
 *   6. a `contract` plan (Enterprise) is never priced or invoiced from the catalog: the outcome is the explicit
 *      `contract_billed` result, not a zero invoice that would look like "paid nothing".
 *
 * Price formula for a `usage_minimum` plan (Builder, Team), in exact integer cents:
 *
 *   usageCents = round-half-up(ZCU-hours x zcuRateMillicents / 1000)      <- the ONE rounding step
 *   totalCents = max(minimumCents, usageCents)
 *
 * ZCU-hours are `managed_resource_hours`. Build minutes and storage are included in the plan and never charged. Estimated
 * meters (COST egress) and informational meters are listed with a zero amount and are never charged.
 */
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { collectUsage } from "./metering";
import { periodEnded } from "./period";
import { BILLABLE_METERS, METER_UNITS, ZCU_METER, getPlan, isKnownPlanId, type PlanDefinition } from "./plans";
import type { InvoiceProvider } from "./provider";
import { BillingProviderError } from "./provider";
import {
  aggregateUsage, getAccount, getInvoiceByPeriod, insertDraftInvoice, markInvoiceNoCharge, markInvoiceOpen, recordInvoiceError, setStripeCustomer,
  type Invoice, type InvoiceLine, type UsageTotal,
} from "./store";

export interface PricedInvoice { lines: InvoiceLine[]; subtotalCents: number; digest: string }

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
/** $0.015 for 1500 millicents (thousandths of a cent). */
const rateUsd = (millicents: number): string => `$${(millicents / 100_000).toFixed(3)}`;

/**
 * The usage charge for `zcuHours` at `zcuRateMillicents` (thousandths of a US cent per ZCU-hour), in whole cents. Hours are
 * taken to micro-hour precision (the meter's own precision) and the product is exact in BigInt; the single rounding step is
 * half-up to the cent.
 */
export function zcuUsageCents(zcuHours: number, zcuRateMillicents: number): number {
  if (!Number.isFinite(zcuHours) || zcuHours <= 0) return 0;
  const microHours = BigInt(Math.round(zcuHours * 1e6));
  const denominator = 1_000_000_000n; // 1e6 micro-hours x 1e3 millicents per cent
  return Number((microHours * BigInt(zcuRateMillicents) + denominator / 2n) / denominator);
}

/** Monthly total for a usage_minimum plan: max(minimum, usage charge). */
export const usageMinimumTotalCents = (minimumCents: number, usageCents: number): number => Math.max(minimumCents, usageCents);

export function priceInvoice(plan: PlanDefinition, totals: readonly UsageTotal[], period: string): PricedInvoice {
  if (plan.pricing.kind === "contract") throw new RangeError(`plan ${plan.id} is billed by contract and is never priced from the catalog`);
  const lines: InvoiceLine[] = [];
  const quantityOf = (meter: string): number => round6(totals.find((t) => t.meter === meter)?.quantity ?? 0);

  if (plan.pricing.kind === "usage_minimum") {
    const { minimumCents, zcuRateMillicents } = plan.pricing;
    const zcuHours = quantityOf(ZCU_METER);
    const usageCents = zcuUsageCents(zcuHours, zcuRateMillicents);
    const totalCents = usageMinimumTotalCents(minimumCents, usageCents);
    // Informational line: the facts behind the amount due. It carries no amount itself; the lines below sum to the total.
    lines.push({
      key: "zcu_hours",
      description: `Management usage: ${zcuHours} ZCU-hours at ${rateUsd(zcuRateMillicents)} per ZCU-hour = ${usd(usageCents)} usage charge. ${plan.name} monthly minimum ${usd(minimumCents)}. Amount due ${usd(totalCents)} (the greater of the two)`,
      quantity: zcuHours, unit: METER_UNITS[ZCU_METER], unitCents: zcuRateMillicents / 1000, amountCents: 0,
    });
    lines.push({ key: "minimum", description: `${plan.name} monthly minimum (covers the first ${usd(minimumCents)} of management usage)`, quantity: 1, unit: "period", unitCents: minimumCents, amountCents: minimumCents });
    if (usageCents > minimumCents) {
      const above = usageCents - minimumCents;
      lines.push({ key: "usage_above_minimum", description: `Management usage above the ${usd(minimumCents)} minimum (${usd(usageCents)} usage charge less ${usd(minimumCents)})`, quantity: above, unit: "cent", unitCents: 1, amountCents: above });
    }
  }

  // Build minutes and storage are included in the plan: shown, never charged. Their fair-use hard caps refuse new work instead.
  for (const meter of BILLABLE_METERS) {
    if (meter === ZCU_METER) continue;
    const quantity = quantityOf(meter);
    if (quantity <= 0) continue;
    const cap = plan.meters[meter].hardCap;
    lines.push({
      key: meter,
      description: `${meter.replaceAll("_", " ")}: ${quantity} ${METER_UNITS[meter]} used, included in the plan (not charged${cap !== undefined ? `; fair-use cap ${cap}` : ""})`,
      quantity, unit: METER_UNITS[meter], unitCents: 0, amountCents: 0,
    });
  }
  for (const t of totals) {
    if (BILLABLE_METERS.includes(t.meter as (typeof BILLABLE_METERS)[number])) continue;
    lines.push({ key: t.meter, description: `${t.meter.replaceAll("_", " ")}${t.estimated ? " (estimate, not charged)" : " (not charged)"}`, quantity: round6(t.quantity), unit: METER_UNITS[t.meter], unitCents: 0, amountCents: 0 });
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  return { lines, subtotalCents, digest: digest({ kind: "zenith.invoice.v2", plan: plan.id, period, lines, subtotalCents }) };
}

export interface GenerateInvoiceDeps {
  provider?: InvoiceProvider;
  now: Date;
  netDays: number;
}

export type GenerateInvoiceResult =
  | { status: "not_ready"; reason: "period_open" | "no_account" | "unknown_plan" }
  /** The plan is billed by contract outside Zenith: no invoice row, no provider call, and explicitly not "paid nothing". */
  | { status: "contract_billed"; planId: string }
  | { status: "ok"; invoice: Invoice; created: boolean; providerCalled: boolean; note?: "provider_not_configured" | "provider_error" };

export async function generateInvoice(sql: Sql, deps: GenerateInvoiceDeps, workspaceId: string, period: string): Promise<GenerateInvoiceResult> {
  if (!periodEnded(period, deps.now)) return { status: "not_ready", reason: "period_open" };
  const account = await getAccount(sql, workspaceId);
  if (!account) return { status: "not_ready", reason: "no_account" };
  if (!isKnownPlanId(account.planId)) return { status: "not_ready", reason: "unknown_plan" };
  if (getPlan(account.planId).pricing.kind === "contract") return { status: "contract_billed", planId: getPlan(account.planId).id };

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
