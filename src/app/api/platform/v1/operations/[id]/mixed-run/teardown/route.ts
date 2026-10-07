/**
 * POST /api/platform/v1/operations/:id/mixed-run/teardown
 *
 * Teardown of an applied mixed run is a proposal, never an automatic compensation (PROD-MIX-04).
 * Browser-only, editor or admin.
 *   { action: "propose" }                              writes the reverse-dependency proposal: one step per applied
 *                                                      child, managed and owned addresses only, refused when an
 *                                                      address is not owned by the run or something outside depends on it.
 *   { action: "release", childId, destroyOperationId } releases one step to the existing destroy path, only when that
 *                                                      infrastructure.destroy operation is approved by a human admin
 *                                                      for exactly the step's addresses and the ordering rules allow it.
 *   { action: "sync", childId }                        records the released step's outcome from the destroy operation's
 *                                                      own status (never from the caller).
 * Nothing here destroys anything; the destroy operation does, under its own approval.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformTeardownPlanInput } from "@/lib/execution/mixed-orchestration/platform";
import { NO_SIGNALS, proposeTeardown, readMixedRun, releaseTeardown, syncTeardownStep } from "@/lib/execution/mixed-orchestration/service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { authorizeRunControl, guarded, mixedContext } from "../../../../_lib/mixed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const CHILD = z.string().min(1).max(200);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose") }).strict(),
  z.object({ action: z.literal("release"), childId: CHILD, destroyOperationId: z.string().regex(ID) }).strict(),
  z.object({ action: z.literal("sync"), childId: CHILD }).strict(),
]);

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const { broker, sql, deps } = await mixedContext();
  await authorizeRunControl(broker, caller.workspaceId, id, caller.principal, { staffOnly: true });
  if (body.action === "propose") {
    const current = await guarded(() => readMixedRun(deps, caller.workspaceId, id));
    if (!current) throw notFound();
    const plan = await platformTeardownPlanInput(sql, current.state);
    const report = await guarded(() => proposeTeardown(deps, { workspaceId: caller.workspaceId, parentOperationId: id, plan }));
    return { status: 201, body: { teardown: report.state.teardown, retained: report.retained, nothingToDestroy: report.nothingToDestroy } };
  }
  if (body.action === "release") {
    // Drift and migration observations come from the executor that drives the run; a manual release carries none and
    // relies on the run's own ordering state and the destroy approval.
    const summary = await guarded(() =>
      releaseTeardown(deps, { workspaceId: caller.workspaceId, parentOperationId: id, childId: body.childId, destroyOperationId: body.destroyOperationId, signals: NO_SIGNALS }),
    );
    return { body: { summary } };
  }
  const summary = await guarded(() => syncTeardownStep(deps, { workspaceId: caller.workspaceId, parentOperationId: id, childId: body.childId }));
  return { body: { summary } };
});
