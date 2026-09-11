/**
 * `POST /api/internal/tick/jobs` — one pass of the hosted publish-job runner.
 *
 * `ran: false` when hosted mode is off or the control authority is not open on
 * this instance, which is the honest answer rather than a zero that looks like
 * an empty queue. The claimed runs are async and outlive the request, so the
 * body reports the queue either side of the tick instead of pretending to have
 * finished anything. See `src/lib/server/cron.ts`.
 */
import { cronRoute, jobTickPass } from "@/lib/server/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = cronRoute("jobs", async () => ({ ...(await jobTickPass()) }));
