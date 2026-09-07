/**
 * Resume a suspended app.
 *
 * It starts serving the release it was serving before, from the same artifact
 * bytes, to the same people: suspension took nothing away, so resuming does
 * not have to put anything back.
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

const ResumeBody = z.object({ jobId: z.string().uuid(), reason: z.string().trim().max(300).optional() });

export const POST = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "admin");
  const body = await readBody(req, ResumeBody, 'POST { "jobId": "<uuid you generate>" }.');
  const result = await executeHosted(
    "app.resume",
    buildCtx({}, actor),
    { appId, jobId: body.jobId, reason: body.reason }
  );
  const data = result.data as { job: unknown; jobId: string; created: boolean };
  return accepted({ job: data.job, jobId: data.jobId, created: data.created });
});
