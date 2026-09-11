/**
 * `GET /api/internal/keepalive` — the daily Vercel cron, and nothing else.
 *
 * A free Supabase project is paused after a week without activity, and a paused
 * project is a production outage that nobody caused. The Hobby plan runs Vercel
 * Cron at most once per day, which is useless for ticking and exactly right for
 * this: one authenticated request a day that reads the store and reports what it
 * found. Vercel attaches the `Authorization: Bearer $CRON_SECRET` header itself
 * once the variable is set on the project.
 *
 * The per-five-minute work is in `.github/workflows/tick.yml`; see
 * `src/lib/server/cron.ts` for why the two schedules are split.
 */
import { cronRoute } from "@/lib/server/cron";
import { db } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export const GET = cronRoute("keepalive", async () => {
  // A real read through the primed snapshot: on Postgres that is a round trip
  // to the project, which is the entire point of the route.
  const data = db();
  return {
    workspaces: data.workspaces.length,
    projects: data.projects.length,
    deployments: data.deployments.length,
  };
});
