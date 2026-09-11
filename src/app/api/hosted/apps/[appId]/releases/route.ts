/**
 * Every release of an app, newest first, and which one is serving.
 *
 * `activeReleaseId` is read from the app record rather than searched for among
 * the releases: the durable choice of what is live is one column guarded by a
 * fence, and a list that worked it out by scanning for a status could disagree
 * with the gateway for as long as a write was in flight.
 */
import { authority } from "@/lib/hosted/authority";
import type { ReleasesWire } from "@/lib/hosted/contracts";
import { requireOwnedApp } from "@/lib/hosted/release";
import { hostedRoute } from "@/lib/server/hosted";
import { intParam, requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(
  { workspaceRole: "viewer" },
  async (req, { appId }): Promise<ReleasesWire> => {
    const app = requireOwnedApp(appId, requireWorkspace().id);
    const limit = intParam(req, "limit", 50, { min: 1, max: 200 });
    return {
      releases: authority().repos.releases.listByApp(app.id, { limit }),
      activeReleaseId: app.activeReleaseId,
      activeFence: app.activeFence,
    };
  }
);
