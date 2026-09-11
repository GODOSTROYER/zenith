/**
 * `POST /api/internal/tick/engine` — advance every in-flight deployment.
 *
 * The scheduler's stand-in for the 250 ms ticker a serverless instance cannot
 * run. One bounded pass with a ~20 s wall-clock budget and as many steps per
 * deployment as that buys; see `src/lib/server/cron.ts` for the whole design,
 * including why the bearer is checked before anything is read.
 *
 * `?budgetMs=` narrows the budget (tests and a manual curl); it can never
 * widen it past `ENGINE_BUDGET_MS`.
 */
import type { NextRequest } from "next/server";
import { ENGINE_BUDGET_MS, cronRoute, engineTickPass } from "@/lib/server/cron";
import { intParam } from "@/lib/server/context";

export const dynamic = "force-dynamic";
/** The pass budgets itself to 20 s; this is the Hobby-plan ceiling above it. */
export const maxDuration = 60;

export const POST = cronRoute("engine", async (req: NextRequest) => ({
  ...(await engineTickPass(
    intParam(req, "budgetMs", ENGINE_BUDGET_MS, { min: 0, max: ENGINE_BUDGET_MS })
  )),
}));
