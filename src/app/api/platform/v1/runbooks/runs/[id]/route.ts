/** GET /api/platform/v1/runbooks/runs/:id   one run with per-target step custody and its hash-chained audit trail. */
import { notFound } from "@/lib/capabilities/errors";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
import { routeId, withRunbooks } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const out = await withRunbooks((rb) => rb.service.readRun({ workspaceId: caller.workspaceId, runId: routeId(id), principal: caller.principal }));
  if (!out) throw notFound();
  return { body: out };
});
