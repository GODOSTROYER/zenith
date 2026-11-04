/** GET /api/platform/v1/runbooks/schedules   schedules in the workspace, newest first. */
import { platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";
import { withRunbooks } from "../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50") || 50));
  const schedules = await withRunbooks((rb) => rb.service.listSchedules({ workspaceId: caller.workspaceId, principal: caller.principal, limit }));
  return { body: { schedules } };
});
