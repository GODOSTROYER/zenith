/** POST /api/platform/v1/runbooks/runs/:id/cancel   cancel a pending run, or stop a running one before its next step. Body: `{ reason? }`. */
import { z } from "zod";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { callerOf } from "../../../../_lib/principal";
import { routeId, withRunbooks } from "../../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ reason: z.string().max(200).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const body = parseWith(Body, await readJson(req));
  const run = await withRunbooks((rb) => rb.service.cancelRun({ workspaceId: caller.workspaceId, runId: routeId(id), principal: caller.principal, reason: body.reason ?? "cancelled" }));
  return { body: { run } };
});
