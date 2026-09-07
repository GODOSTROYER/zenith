/**
 * Put an app back onto a release it already ran.
 *
 * A rollback is not a restore and this route will not pretend otherwise: it
 * changes which artifact serves and touches no record any user wrote. The
 * compatibility check between the target release's schema and the app's data
 * happens inside the job, before the pointer moves.
 *
 * Workstream W7 (hosted R3).
 */
import { z } from "zod";
import "@/lib/actions/defs/hosted";
import {
  accepted,
  actorOf,
  executeHosted,
  hostedRoute,
  readBody,
  requireWorkspaceRole,
} from "@/lib/hosted/release/http";
import { buildCtx } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const RollbackBody = z.object({ jobId: z.string().uuid(), releaseId: z.string().min(1) });

export const POST = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "editor");
  const body = await readBody(
    req,
    RollbackBody,
    'POST { "jobId": "<uuid you generate>", "releaseId": "<a release from GET …/releases>" }.'
  );
  const result = await executeHosted(
    "app.rollback",
    buildCtx({}, actor),
    { appId, jobId: body.jobId, releaseId: body.releaseId },
    { idempotencyKey: body.jobId }
  );
  const data = result.data as { job: unknown; jobId: string; created: boolean };
  return accepted({ job: data.job, jobId: data.jobId, created: data.created });
});
