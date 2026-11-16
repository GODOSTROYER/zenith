/**
 * GET /api/platform/v1/operations/:id
 *
 * One operation with the decision it was created under and its approvals.
 * A foreign id and a missing id are the same 404. `authority` is the derived
 * projection of the operation's authority record (PROD-DUR-02): authority
 * version, delivery phase, retained start intent and durable intents. It is
 * omitted when no platform store is open (local memory mode).
 */
import { notFound } from "@/lib/capabilities/errors";
import { isMemoryStoreEnabled, platformBroker } from "@/lib/capabilities/platform";
import { projectOperation } from "@/lib/controlplane/authority";
import { platformRoute } from "../../_lib/http";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const detail = await (await platformBroker()).getOperationDetail({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal });
  // Read only after the broker proved the caller may see this operation.
  const authority = isMemoryStoreEnabled() ? null : await (async () => {
    try { const { platformDb } = await import("@/lib/controlplane/db"); return await projectOperation(await platformDb(), caller.workspaceId, id); }
    catch { return null; }
  })();
  return { body: authority ? { ...detail, authority } : detail };
});
