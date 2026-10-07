/**
 * GET /api/platform/v1/operations/:id/mixed-run
 *
 * The orchestration state of a mixed graph's child workflows for this parent operation: per child
 * status, effect knowledge, receipts, blocked dependents and teardown proposal, plus the append-only
 * ledger. It states what happened and never claims atomicity: `atomicity` is always `none` and
 * `automaticCompensation` is always `never`. A foreign id, a missing id and an operation without a
 * run are the same 404.
 */
import { notFound } from "@/lib/capabilities/errors";
import { readMixedRun } from "@/lib/execution/mixed-orchestration/service";
import { platformRoute } from "../../../_lib/http";
import { guarded, mixedContext } from "../../../_lib/mixed-run";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const { broker, deps } = await mixedContext();
  await broker.getOperationDetail({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal });
  const run = await guarded(() => readMixedRun(deps, caller.workspaceId, id));
  if (!run) throw notFound();
  const ledger = await guarded(() => deps.runs.events(caller.workspaceId, id, 200));
  return { body: { summary: run.summary, run: run.state, ledger } };
});
