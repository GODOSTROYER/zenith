/**
 * Suspend an app: stop admitting requests, destroy nothing.
 *
 * Workspace admin plus the app's owner grant, because this is the control that
 * takes a live product away from the people using it. Data, grants,
 * invitations, releases and artifacts are all kept, and resume puts the app
 * back exactly where it was.
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

const SuspendBody = z.object({ jobId: z.string().uuid(), reason: z.string().trim().max(300).optional() });

export const POST = hostedRoute<{ appId: string }>(async (req, { appId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "admin");
  const body = await readBody(
    req,
    SuspendBody,
    'POST { "jobId": "<uuid you generate>", "reason": "why this app is being suspended" }.'
  );
  const result = await executeHosted(
    "app.suspend",
    buildCtx({}, actor),
    { appId, jobId: body.jobId, reason: body.reason },
    { idempotencyKey: body.jobId }
  );
  const data = result.data as { job: unknown; jobId: string; created: boolean };
  return accepted({ job: data.job, jobId: data.jobId, created: data.created });
});
