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
import { operationForRest, restrictedSourceRead } from "../../_lib/source-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const GET = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!ID.test(id)) throw notFound();
  const detail = await (await platformBroker()).getOperationDetail({ workspaceId: caller.workspaceId, operationId: id, principal: caller.principal });
  if (restrictedSourceRead(detail.operation, caller)) return { body: {
    operation: operationForRest(detail.operation, caller), sourceContextOmitted: true,
    approvals: detail.approvals.map(a => ({ id: a.id, decision: a.decision, approverId: a.approverId,
      approverRole: a.approverRole, policyVersion: a.policyVersion, createdAt: a.createdAt,
      expiresAt: a.expiresAt, consumed: a.consumed, approvalRound: a.approvalRound })),
  } };
  // Read only after the broker proved the caller may see this operation.
  const authority = isMemoryStoreEnabled() ? null : await (async () => {
    try { const { platformDb } = await import("@/lib/controlplane/db"); return await projectOperation(await platformDb(), caller.workspaceId, id); }
    catch { return null; }
  })();
  return { body: authority ? { ...detail, authority } : detail };
});
