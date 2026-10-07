/**
 * `GET|POST /api/admin/billing/invoices` - invoice generation through the Stripe TEST adapter (PROD-MAN-06). Platform
 * operators only, same-origin for writes.
 *
 *   GET ?workspaceId=ID                    the workspace's invoices
 *   POST { workspaceId, period: "YYYY-MM" } generate (or return) the invoice for an ENDED period
 *
 * Idempotent: a period has exactly one invoice and a repeat returns it. Invoicing needs ZENITH_BILLING_STRIPE_SECRET_KEY
 * (a test-mode key, refused otherwise); without it the invoice stays `draft` and the answer says so. A period that has not
 * ended is refused. Answers 404 `billing_disabled` when billing is not managed on this host.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { billingConfigFromEnv } from "@/lib/billing/config";
import { generateInvoice } from "@/lib/billing/invoice";
import { isPeriod } from "@/lib/billing/period";
import { PLAN_NOTICE } from "@/lib/billing/plans";
import { invoiceProviderFromEnv } from "@/lib/billing/service";
import { listInvoices } from "@/lib/billing/store";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Body = z.object({ workspaceId: id, period: z.string().refine(isPeriod, "period must be YYYY-MM") }).strict();

function requireManaged(): ReturnType<typeof billingConfigFromEnv> {
  const cfg = billingConfigFromEnv();
  if (cfg.mode !== "managed") throw new ApiError("Billing is not enabled on this installation.", 404, { fix: "Set ZENITH_BILLING=managed on a Zenith-operated installation." });
  return cfg;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    requireManaged();
    const ws = id.safeParse(request.nextUrl.searchParams.get("workspaceId"));
    if (!ws.success) throw new ApiError("workspaceId is required.", 400);
    return json({ notice: PLAN_NOTICE, invoices: await listInvoices(await opsStore(), ws.data, 48) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    const cfg = requireManaged();
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Send { workspaceId, period: \"YYYY-MM\" }.", 400);
    const result = await generateInvoice(await opsStore(), { provider: invoiceProviderFromEnv(), now: new Date(), netDays: cfg.netDays }, parsed.data.workspaceId, parsed.data.period);
    if (result.status === "not_ready") {
      throw new ApiError(
        result.reason === "period_open" ? "That period has not ended, so it cannot be invoiced yet." : result.reason === "no_account" ? "That workspace has no billing account; assign a plan first." : "That account's plan is not in the catalog.",
        result.reason === "period_open" ? 409 : 404);
    }
    log.info("billing invoice generated", { scope: "billing", workspaceId: parsed.data.workspaceId, period: parsed.data.period, status: result.invoice.status, actor: operator.id });
    return json({ invoice: result.invoice, created: result.created, providerCalled: result.providerCalled, ...(result.note ? { note: result.note } : {}), notice: PLAN_NOTICE });
  } catch (error) { return errorResponse(error); }
}
