/**
 * `POST /api/internal/tick/reconcile` — one bounded pass of the reconciliation
 * controller.
 *
 * Same gate as every other tick route (`authorizeCron`: `Authorization: Bearer
 * $CRON_SECRET`, constant-time, 401 on a wrong or missing bearer, 503 when the
 * deployment has no `CRON_SECRET` — never "run it anyway"), but deliberately
 * NOT `cronRoute()`: that wrapper boots the legacy product engine and primes a
 * full product-store snapshot, and reconciliation reads and writes the
 * platform control store only. The bearer is still checked before anything is
 * read.
 *
 * The pass runs against the ports the orchestrator wired with
 * `wireReconcilePorts()`. With none wired the answer is 503
 * (`platform_store_unavailable`), never a 200 that reports "0 drift" for a
 * fleet nobody looked at; `ZENITH_RECONCILE_MEMORY=1` opts into an in-memory
 * backend for local development.
 *
 * `?budgetMs=` narrows the start-gate budget and `?max=` the number of
 * environments claimed (tests and a manual curl); neither can widen past the
 * pass's own ceilings. Counts come back, not prose: see `ReconcilePassResult`.
 */
import type { NextRequest } from "next/server";
import { authorizeCron, ensurePlatformCron } from "@/lib/server/cron";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import { intParam } from "@/lib/server/request";
import { log, withRequestId } from "@/lib/log";
import { DEFAULT_MAX_ENVIRONMENTS, RECONCILE_BUDGET_MS, ReconcileError, reconcilePass } from "@/lib/reconcile";

export const dynamic = "force-dynamic";
/** The pass starts no environment after ~20 s and stops everything by 50 s; this is the ceiling above it. */
export const maxDuration = 60;

export const POST = async (req: NextRequest): Promise<Response> => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID().slice(0, 8);
  return withRequestId(requestId, async () => {
    try {
      authorizeCron(req);
      await ensurePlatformCron(); // this route deliberately bypasses legacy boot
      const started = Date.now();
      const counts = await reconcilePass({
        budgetMs: intParam(req, "budgetMs", RECONCILE_BUDGET_MS, { min: 0, max: RECONCILE_BUDGET_MS }),
        maxEnvironments: intParam(req, "max", DEFAULT_MAX_ENVIRONMENTS, { min: 0, max: 500 }),
      });
      const body = { pass: "reconcile", ok: true, ...counts, ms: Date.now() - started };
      log.info("internal tick", { scope: "cron", ...body });
      const res = json(body);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      const res = errorResponse(
        err instanceof ReconcileError && err.code === "platform_store_unavailable"
          ? new ApiError(err.message, 503, {
              fix: "Wire the platform store into the reconciliation controller (wireReconcilePorts) at boot, or set ZENITH_RECONCILE_MEMORY=1 for local development.",
            })
          : err
      );
      res.headers.set("x-request-id", requestId);
      return res;
    }
  });
};
