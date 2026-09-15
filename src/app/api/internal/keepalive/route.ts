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
import { db, isPostgres } from "@/lib/db/store";
import { withMutationGate } from "@/lib/actions/mutation-gate";
import { log } from "@/lib/log";
import { reconcilePendingAccountDeletionsAsync } from "@/lib/server/account";

export const dynamic = "force-dynamic";

/**
 * Why the reconcile pass is fenced the same way `DELETE /api/account` is.
 *
 * That route refuses `isPostgres()` with a 503 before it touches anything,
 * because local cleanup is several PostgREST writes — member rows, invites and
 * one audit row per workspace — and several PostgREST requests are not one
 * transaction. This pass performs *the same cleanup*
 * (`removeAccountRecordsAsync`), so running it here on Postgres would execute
 * exactly what the user-facing route exists to refuse — and it would do it
 * inside the cron pass's unfiltered snapshot, where `membershipsOf` matches
 * across every workspace on the install rather than the caller's.
 *
 * So it fails closed identically, and takes the single-writer gate on the mode
 * where it does run, so a tick that overlaps a request cannot interleave with
 * a member write.
 */
async function reconcileAccountDeletions(): Promise<{ reconciled: number; outcome: string }> {
  if (isPostgres()) {
    log.info("account-deletion reconcile refused", {
      scope: "account",
      reason: "Product storage uses PostgreSQL; local cleanup is not one transaction there",
      fix: "Run the coordinated account-deletion workflow, or use the supported single-writer file-store mode.",
    });
    return { reconciled: 0, outcome: "refused-postgres" };
  }
  return {
    reconciled: await withMutationGate(() => reconcilePendingAccountDeletionsAsync()),
    outcome: "ran",
  };
}

export const GET = cronRoute("keepalive", async () => {
  // A real read through the primed snapshot: on Postgres that is a round trip
  // to the project, which is the entire point of the route.
  const data = db();
  const { reconciled, outcome } = await reconcileAccountDeletions();
  return {
    workspaces: data.workspaces.length,
    projects: data.projects.length,
    deployments: data.deployments.length,
    accountDeletionsReconciled: reconciled,
    accountDeletionReconcile: outcome,
  };
});
