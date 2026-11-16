/** POST /api/platform/v1/runbooks/schedules/:id/state   pause, resume or cancel a schedule. Body: `{ state: "paused" | "active" | "cancelled" }`. */
import { z } from "zod";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { callerOf } from "../../../../_lib/principal";
import { routeId, withRunbooks } from "../../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ state: z.enum(["paused", "active", "cancelled"]) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const body = parseWith(Body, await readJson(req));
  await withRunbooks((rb) => rb.service.setScheduleState({ workspaceId: caller.workspaceId, scheduleId: routeId(id), state: body.state, principal: caller.principal }));
  return { body: { state: body.state } };
});
