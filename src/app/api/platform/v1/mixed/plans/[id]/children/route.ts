/**
 * POST /api/platform/v1/mixed/plans/:id/children
 *
 * Browser-only. Binds one normal deploy operation of a child environment to its
 * partition of the parent plan. The service proves the operation's revision expands
 * to exactly the approved subplan (same resources, specs, provider and region) and
 * that the child's connection and state backend still match the approval; the
 * binding is write-once. It does not approve or start anything: the child keeps its
 * own approval and the parent starts it only after the previous child succeeded.
 * Body: `{ partitionId, operationId }`.
 */
import { z } from "zod";
import { authorizeEnvironment } from "@/app/(product)/platform/_lib/read-models";
import { notFound } from "@/lib/capabilities/errors";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { mixedDeps } from "@/lib/execution/mixed/runtime";
import { adoptChildOperation } from "@/lib/execution/mixed/service";
import { assertBrowserSession } from "../../../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { guarded } from "../../../../_lib/mixed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const Body = z.object({ partitionId: z.string().regex(/^[A-Za-z0-9_.:/-]{1,200}$/), operationId: z.string().regex(ID) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await assertBrowserSession(req);
  if (!ID.test(id)) throw notFound();
  const body = parseWith(Body, await readJson(req));
  const deps = await mixedDeps();
  const stored = await guarded(() => plans.getPlan(deps.sql, caller.workspaceId, id));
  if (!stored) throw notFound();
  await authorizeEnvironment({ workspaceId: caller.workspaceId, principal: caller.principal, surface: "rest" }, stored.plan.parentEnvironmentId, "infrastructure.observe");
  // Only the person who made the plan binds children to it.
  if (stored.createdBy !== caller.principal.id) throw notFound();
  const child = await guarded(() => adoptChildOperation(deps, { workspaceId: caller.workspaceId, planId: id, partitionId: body.partitionId, operationId: body.operationId }));
  return { status: 201, body: { child } };
});
