/**
 * GET /api/platform/v1/releases/:id
 *
 * One release run with its transition history and a code-rollback safety verdict for its digest:
 * whether restoring this digest is safe, or a contract migration has run since it served (then a
 * code rollback is refused and the only options are rolling forward or a reviewed data restore).
 */
import { platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";
import { requireRole, routeId, withReleases } from "../../_lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  await requireRole(caller.principal, caller.workspaceId, "viewer", "read");
  const body = await withReleases(async (svc) => {
    const release = await svc.get(caller.workspaceId, routeId(id));
    const [events, rollbackSafety] = await Promise.all([
      svc.events(caller.workspaceId, release.id),
      svc.rollbackSafety({ workspaceId: release.workspaceId, environmentId: release.environmentId, serviceAddress: release.serviceAddress, targetDigest: release.imageDigest }),
    ]);
    return { release, events, rollbackSafety };
  });
  return { body };
});
