/**
 * `POST /api/internal/tick/runbooks` — one bounded pass of signed-runbook scheduling.
 *
 * Decides every due schedule slot (at most one run per slot, late slots recorded as missed,
 * unverifiable or unapproved slots blocked and audited) and then executes approved runs whose
 * schedule or request is due. All state lives in the platform store, so nothing is lost if this
 * is not called for a while or the process restarts: the cursor is compare-and-set, an expired
 * run lease is reclaimed, and a step that was in flight is marked uncertain, never re-dispatched.
 *
 * Same gate as every tick route: `Authorization: Bearer $CRON_SECRET`, checked before anything
 * is read. `?budgetMs=` narrows the execution budget; it cannot widen the pass's ceiling.
 * Control-store only, like the reconcile tick: it does not boot the legacy product engine.
 */
import type { NextRequest } from "next/server";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { errorResponse, json } from "@/lib/server/errors";
import { intParam } from "@/lib/server/request";
import { log, withRequestId } from "@/lib/log";
import { runbookTickPass } from "@/lib/platform/runbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const RUNBOOK_TICK_BUDGET_MS = 45_000;

export const POST = async (req: NextRequest): Promise<Response> => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  return withRequestId(requestId, async () => {
    try {
      authorizeCron(req);
      await ensurePlatformCron();
      const started = Date.now();
      const result = await runbookTickPass({ budgetMs: intParam(req, "budgetMs", RUNBOOK_TICK_BUDGET_MS, { min: 1_000, max: RUNBOOK_TICK_BUDGET_MS }) });
      const body = { pass: "runbooks", ok: true, ...result, ms: Date.now() - started };
      log.info("internal tick", { scope: "cron", ...body });
      const res = json(body);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      const res = errorResponse(err);
      res.headers.set("x-request-id", requestId);
      return res;
    }
  });
};
