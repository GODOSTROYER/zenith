/**
 * POST /api/platform/v1/operations/:id/mixed-run/cancel
 *
 * Propagate a cancellation to a mixed run (PROD-MIX-04). Children that have not started are cancelled now;
 * children that are running are asked to stop and stay `cancel_requested` until they report: a running
 * child is never claimed stopped. Nothing already applied is rolled back. The requester, the human an agent
 * proposed it for, and any editor or admin may. Body: `{}`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { cancelMixedRun } from "@/lib/execution/mixed-orchestration/service";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { authorizeRunControl, guarded, mixedContext } from "../../../../_lib/mixed-run";
import { callerOf } from "../../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  parseWith(z.object({}).strict(), await readJson(req));
  if (!ID.test(id)) throw notFound();
  const { broker, deps } = await mixedContext();
  await authorizeRunControl(broker, caller.workspaceId, id, caller.principal);
  const summary = await guarded(() => cancelMixedRun(deps, caller.workspaceId, id));
  if (!summary) throw notFound();
  return { body: { summary } };
});
