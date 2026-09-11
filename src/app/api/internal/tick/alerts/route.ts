/**
 * `POST /api/internal/tick/alerts` — one full alert evaluation pass.
 *
 * Exactly what `startAlertEvaluator()`'s 15 s timer would have run, for a host
 * where that timer does not exist. Conditions are re-derived from durable
 * records every time, so a pass that is five minutes late is still correct —
 * it is only late. See `src/lib/server/cron.ts`.
 */
import { alertTickPass, cronRoute } from "@/lib/server/cron";

export const dynamic = "force-dynamic";

export const POST = cronRoute("alerts", async () => ({ ...(await alertTickPass()) }));
