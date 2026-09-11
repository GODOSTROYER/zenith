/**
 * `GET /api/hosted/ops/spending` — the workspace's estimated spend against its
 * envelope, the 50/75/90 % thresholds, and whether builds are paused.
 *
 * Workspace admin only, because it is a money surface for the whole workspace
 * rather than for one app. The refusal says that in its own words, which is
 * why this route still spells the check out instead of declaring
 * `{ workspaceRole: "admin" }`.
 *
 * Every dollar here is an **estimate** derived from Zenith's own counters and
 * the rate table, which is returned alongside so the arithmetic is checkable.
 * The reading also evaluates the thresholds, which is idempotent — each one
 * enqueues at most one alert per workspace per month. It is not the *primary*
 * trigger: `checkSpendThresholds()` is called after usage is recorded, so an
 * alert does not wait for somebody to open this page.
 */
import { HostedError, type HostedSpendingPayload } from "@/lib/hosted/contracts";
import { RATE_TABLE, SPEND_DISCLOSURE, checkSpendThresholds } from "@/lib/hosted/usage";
import { requireWorkspace, resolveActor, workspaceRole } from "@/lib/server/context";
import { hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const GET = hostedRoute(async (req): Promise<HostedSpendingPayload> => {
  const workspace = requireWorkspace();
  const role = workspaceRole(await resolveActor(req));
  if (role !== "admin")
    throw new HostedError(
      "forbidden",
      `Spending is a workspace-wide figure and you are ${role} in ${workspace.name}.`,
      { fix: `Ask an admin of ${workspace.name} to open it, or to give you the admin role.` }
    );

  const { status, crossed } = checkSpendThresholds(workspace.id);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    spending: status,
    /** Thresholds this read was the first to notice. Normally empty. */
    alertsRaised: crossed,
    rateTable: RATE_TABLE,
    disclosure: SPEND_DISCLOSURE,
  };
});
