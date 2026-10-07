/**
 * GET /api/platform/v1/effects/:id
 *
 * One effect: state, provider receipt, any late receipt, the latest independent readback, the resolutions it
 * allows right now (with the binding digest an approver signs), its events and past resolutions.
 * A foreign id and a missing id are the same 404.
 */
import { notFound } from "@/lib/capabilities/errors";
import { platformEffects } from "@/lib/platform/effects";
import { platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  return { body: { effect: await (await platformEffects()).get(caller.principal, caller.workspaceId, id) } };
});
