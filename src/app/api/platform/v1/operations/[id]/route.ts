/**
 * GET /api/platform/v1/operations/:id
 *
 * One operation with the decision it was created under and its approvals.
 * A foreign id and a missing id are the same 404.
 */
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  return { body: await (await platformBroker()).getOperationDetail({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal }) };
});
