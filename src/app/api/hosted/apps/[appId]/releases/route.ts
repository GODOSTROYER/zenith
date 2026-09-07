/**
 * Every release of an app, newest first, and which one is serving.
 *
 * `activeReleaseId` is read from the app record rather than searched for among
 * the releases: the durable choice of what is live is one column guarded by a
 * fence, and a list that worked it out by scanning for a status could disagree
 * with the gateway for as long as a write was in flight.
 *
 * Workstream W7 (hosted R3).
 */
import { authority } from "@/lib/hosted/authority";
import { requireOwnedApp } from "@/lib/hosted/release";
import { actorOf, hostedRoute, requireWorkspaceRole } from "@/lib/hosted/release/http";
import { intParam, requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "viewer");
  const app = requireOwnedApp(appId, requireWorkspace().id);
  const limit = intParam(req, "limit", 50, { min: 1, max: 200 });
  return {
    releases: authority().repos.releases.listByApp(app.id, { limit }),
    activeReleaseId: app.activeReleaseId,
    activeFence: app.activeFence,
  };
});
