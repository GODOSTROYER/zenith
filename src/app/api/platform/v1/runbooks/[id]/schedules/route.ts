/**
 * POST /api/platform/v1/runbooks/:id/schedules
 *
 * Create a bounded schedule (UTC windows required, cadence, optional notBefore/notAfter,
 * duration and parallelism caps) for a published runbook version over an explicit target list.
 * It runs only after an independent person approves the exact schedule binding, when its
 * runbook mutates or runs raw commands. Body: `{ version?, targets, spec }`.
 */
import { z } from "zod";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
import { routeId, withRunbooks } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ version: z.number().int().min(1).optional(), targets: z.unknown(), spec: z.unknown() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const body = parseWith(Body, await readJson(req));
  const schedule = await withRunbooks((rb) => rb.service.createSchedule({ workspaceId: caller.workspaceId, runbookId: routeId(id), version: body.version, targets: body.targets, spec: body.spec, principal: caller.principal }));
  return { status: 201, body: { schedule } };
});
