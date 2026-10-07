/**
 * `GET|PUT /api/admin/billing/assignment` - plan assignment (PROD-MAN-06). Platform operators only (ZENITH_OPS_ADMIN_IDS),
 * same-origin for writes, optimistic `expectedVersion`. Every plan is a provisional placeholder (DEC-BUSINESS).
 *
 *   GET                       the provisional plan catalog and the accounts (bounded)
 *   GET ?workspaceId=ID       one account with its recent audit events
 *   PUT { workspaceId, planId, reason?, expectedVersion? }
 *
 * Assigning a plan never lifts a suspension. Answers 404 `billing_disabled` when billing is not managed on this host.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { billingConfigFromEnv } from "@/lib/billing/config";
import { invalidateBillingState } from "@/lib/billing/admission";
import { DEFAULT_PLAN_ID, PLAN_NOTICE, listPlanViews } from "@/lib/billing/plans";
import { assignPlan, getAccount, listAccountEvents, listAccounts } from "@/lib/billing/store";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator, storeFailure } from "@/lib/ops/operator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Body = z.object({ workspaceId: id, planId: z.string().regex(/^[a-z0-9_]{1,64}$/), reason: z.string().max(300).optional(), expectedVersion: z.number().int().min(0).optional() }).strict();

function requireManaged(): void {
  if (billingConfigFromEnv().mode !== "managed") throw new ApiError("Billing is not enabled on this installation.", 404, { fix: "Set ZENITH_BILLING=managed on a Zenith-operated installation." });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireOpsOperator(request, false);
    requireManaged();
    const sql = await opsStore();
    const raw = request.nextUrl.searchParams.get("workspaceId");
    if (raw !== null) {
      const ws = id.safeParse(raw);
      if (!ws.success) throw new ApiError("workspaceId is invalid.", 400);
      return json({ account: await getAccount(sql, ws.data), events: await listAccountEvents(sql, ws.data, 50) });
    }
    return json({ notice: PLAN_NOTICE, defaultPlanId: DEFAULT_PLAN_ID, plans: listPlanViews(), accounts: await listAccounts(sql, 200) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    requireManaged();
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("The plan assignment request is invalid.", 400);
    const sql = await opsStore();
    let account;
    try { account = await assignPlan(sql, { ...parsed.data, actor: operator.id }); } catch (error) { storeFailure(error); }
    invalidateBillingState(parsed.data.workspaceId);
    log.info("billing plan assigned", { scope: "billing", workspaceId: parsed.data.workspaceId, planId: parsed.data.planId, actor: operator.id });
    return json({ account, notice: PLAN_NOTICE });
  } catch (error) { return errorResponse(error); }
}
