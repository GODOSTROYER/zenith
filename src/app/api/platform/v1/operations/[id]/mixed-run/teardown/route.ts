/**
 * POST /api/platform/v1/operations/:id/mixed-run/teardown
 *
 * Teardown of an applied mixed run is a proposal, never an automatic compensation (PROD-MIX-04).
 * Browser-only, editor or admin.
 *   { action: "propose" }                              writes the reverse-dependency proposal: one step per applied
 *                                                      child, managed and owned addresses only (read from that child's
 *                                                      own environment), refused when an address is not owned by the run
 *                                                      or something outside depends on it.
 *   { action: "release", childId, destroyOperationId } releases one step to the existing destroy path, only when that
 *                                                      infrastructure.destroy operation is in the CHILD's own environment
 *                                                      (env.reviewTeardown of it), approved by a human admin for exactly
 *                                                      the step's addresses, has not ended, and the ordering rules allow it.
 *   { action: "sync", childId }                        records the released step's outcome from the destroy operation's
 *                                                      own status (never from the caller).
 * Each child's environment comes from the run's stored, digest-bound plan, never from the caller.
 * Nothing here destroys anything; the destroy operation does, under its own approval.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import * as mixedPlans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { asOrderingSignals, readRunSignals } from "@/lib/execution/mixed/signals";
import { childEnvironmentsOf, platformTeardownPlanInput } from "@/lib/execution/mixed-orchestration/platform";
import { proposeTeardown, readMixedRun, releaseTeardown, syncTeardownStep } from "@/lib/execution/mixed-orchestration/service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { authorizeRunControl, guarded, mixedContext } from "../../../../_lib/mixed-run";

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
  if (body.action === "sync") {
    const summary = await guarded(() => syncTeardownStep(deps, { workspaceId: caller.workspaceId, parentOperationId: id, childId: body.childId }));
    return { body: { summary } };
  }
  const current = await guarded(() => readMixedRun(deps, caller.workspaceId, id));
  const stored = await mixedPlans.getPlanByParentOperation(sql, caller.workspaceId, id);
  if (!current || !stored) throw notFound();
  const environments = await guarded(async () => childEnvironmentsOf(stored.plan, current.state));
  if (body.action === "propose") {
    const plan = await platformTeardownPlanInput(sql, current.state, environments);
    const report = await guarded(() => proposeTeardown(deps, { workspaceId: caller.workspaceId, parentOperationId: id, plan }));
    return { status: 201, body: { teardown: report.state.teardown, retained: report.retained, nothingToDestroy: report.nothingToDestroy } };
  }
  // release. Drift (reconcile reports) and migration classes (release safety) are read from the platform for every child of the run, so
  // the ordering rules refuse a teardown beside unresolved consumer drift or an unsettled migration. A signal read that fails
  // refuses the release; it is never replaced by "no signals". A child that is not in the run has no step and is refused.
  const signals = asOrderingSignals(await readRunSignals(sql, caller.workspaceId, stored.plan.parentPlanId, stored.plan));
  const summary = await guarded(() =>
    releaseTeardown(deps, { workspaceId: caller.workspaceId, parentOperationId: id, childId: body.childId, destroyOperationId: body.destroyOperationId,
      childEnvironmentId: environments.get(body.childId) ?? "", signals }),
  );
  return { body: { summary } };
});
