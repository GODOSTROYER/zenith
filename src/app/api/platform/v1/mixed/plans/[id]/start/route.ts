/**
 * POST /api/platform/v1/mixed/plans/:id/start
 *
 * Browser-only. After a person approved the parent operation (the exact child set)
 * and every child has an adopted operation, the person the plan was proposed for
 * starts it. Refused for any bearer credential, for a cross-origin request and for
 * an identity the provider does not confirm right now. The parent claims nothing in
 * any cloud: it starts child workflows one at a time, each under its own approvals.
 * Body: `{}`.
 */
import { z } from "zod";
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { mixedDeps } from "@/lib/execution/mixed/runtime";
import { startMixedParent } from "@/lib/execution/mixed/start";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { guarded } from "../../../../_lib/mixed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const Body = z.object({}).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  parseWith(Body, await readJson(req));
  if (!ID.test(id)) throw notFound();
  const deps = await mixedDeps();
  const stored = await guarded(() => plans.getPlan(deps.sql, caller.workspaceId, id));
  if (!stored?.parentOperationId) throw notFound();
  const broker = await platformBroker();
  const operationId = stored.parentOperationId;
  const started = await guarded(() => startMixedParent(broker, deps, { workspaceId: caller.workspaceId, operationId, caller: caller.principal }));
  return { body: started };
});
