/** GET /api/platform/v1/runbooks/runs   recent runs in the workspace, newest first (`?status=`, `?limit=`). */
import { z } from "zod";
import { parseWith, platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";
import { withRunbooks } from "../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Status = z.enum(["pending_approval", "approved", "running", "succeeded", "failed", "cancelled", "expired", "uncertain"]);

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const status = req.nextUrl.searchParams.get("status");
  const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50") || 50));
  const parsed = status === null ? undefined : parseWith(Status, status);
  const runs = await withRunbooks((rb) => rb.service.listRuns({ workspaceId: caller.workspaceId, principal: caller.principal, limit, status: parsed }));
  return { body: { runs } };
});
