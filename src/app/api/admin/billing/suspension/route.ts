/**
 * `POST /api/admin/billing/suspension` - operator suspension or reinstatement of NEW work (PROD-MAN-06). Platform operators
 * only, same-origin, a reason is required.
 *
 *   POST { workspaceId, action: "suspend" | "reinstate", reason }
 *
 * Suspension refuses new dispatch only. It deletes nothing and stops nothing: reads, running workloads, data export and
 * user-requested destroy keep working. Automatic (nonpayment) suspension is the dunning pass, not this route.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { billingConfigFromEnv } from "@/lib/billing/config";
import { reinstateWorkspace, suspendWorkspace } from "@/lib/billing/standing";
import { SUSPENSION_MEANING } from "@/lib/billing/service";
import { log } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { readWaitlistJson } from "@/lib/waitlist/http";
import { opsStore, requireOpsOperator } from "@/lib/ops/operator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  action: z.enum(["suspend", "reinstate"]),
  reason: z.string().trim().min(1).max(300),
}).strict();

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const operator = await requireOpsOperator(request, true);
    if (billingConfigFromEnv().mode !== "managed") throw new ApiError("Billing is not enabled on this installation.", 404, { fix: "Set ZENITH_BILLING=managed on a Zenith-operated installation." });
    const parsed = Body.safeParse(await readWaitlistJson(request));
    if (!parsed.success) throw new ApiError("Send { workspaceId, action: \"suspend\" | \"reinstate\", reason }.", 400);
    const { workspaceId, action, reason } = parsed.data;
    const sql = await opsStore();
    const args = { workspaceId, actor: operator.id, reason, now: new Date() };
    const account = action === "suspend" ? await suspendWorkspace(sql, args) : await reinstateWorkspace(sql, args);
    if (!account) throw new ApiError("That workspace has no billing account.", 404, { fix: "Assign a plan first." });
    log.info("billing standing changed by operator", { scope: "billing", workspaceId, action, actor: operator.id });
    return json({ account, whatSuspensionMeans: SUSPENSION_MEANING });
  } catch (error) { return errorResponse(error); }
}
