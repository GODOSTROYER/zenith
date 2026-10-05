/**
 * POST /api/platform/v1/runbooks/:id/runs
 *
 * Request one bounded run of a published runbook version. Body: `{ version?, targets,
 * windows?, notAfter?, maxRunDurationSec?, maxParallelTargets? }`. The answer carries the
 * `bindingDigest`: the exact immutable effect (version digest, targets, bounds) a person
 * approves in the browser. Read-only runbooks start approved; anything that mutates or runs
 * a raw command waits for an independent human.
 */
import { z } from "zod";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
import { routeId, withRunbooks } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z
  .object({
    version: z.number().int().min(1).optional(),
    targets: z.unknown(),
    windows: z.unknown().optional(),
    notAfter: z.string().datetime({ offset: false }).optional(),
    maxRunDurationSec: z.number().int().optional(),
    maxParallelTargets: z.number().int().optional(),
  })
  .strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  const body = parseWith(Body, await readJson(req));
  const run = await withRunbooks((rb) => rb.service.requestRun({ workspaceId: caller.workspaceId, runbookId: routeId(id), version: body.version, targets: body.targets, windows: body.windows, notAfter: body.notAfter, maxRunDurationSec: body.maxRunDurationSec, maxParallelTargets: body.maxParallelTargets, principal: caller.principal }));
  return { status: 201, body: { run } };
});
