/**
 * GET /api/platform/v1/operations/:id/events
 *
 * The operation's structured events in order (`?afterSeq=`, `?limit=` 1–500).
 * `data` is a redacted summary; never a secret.
 */
import { notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { intParam } from "@/lib/server/request";
import { platformRoute } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";
import { restrictedSourceRead } from "../../../_lib/source-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const after = req.nextUrl.searchParams.get("afterSeq");
  const broker = await platformBroker();
  const restricted = (caller.via === "bearer" || caller.via === "navigator") && restrictedSourceRead(
    (await broker.getOperationDetail({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal })).operation, caller);
  const page = await broker.listOperationEvents({
    workspaceId: caller.workspaceId,
    operationId: id,
    principal: caller.principal,
    afterSeq: after === null ? undefined : intParam(req, "afterSeq", 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    limit: intParam(req, "limit", 100, { min: 1, max: 500 }),
  });
  return { body: { events: restricted ? page.items.map(event => ({ seq: event.seq, id: event.id, ts: event.ts,
    type: event.type, operationId: event.operationId, correlationId: event.correlationId,
    data: { sourceContextOmitted: true } })) : page.items } };
});
