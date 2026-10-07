/**
 * GET /api/platform/v1/recovery?state=pending
 *
 * The recovery epoch of the control plane and the work a restore left for a person: operations, intents and
 * external effects that were in flight in the restored data, each with the `bindingDigest` a decision must carry
 * and the reasons a `resume` would be refused right now. A viewer or a human-bound read credential may list; a
 * foreign workspace is the same empty answer as a missing one.
 */
import { BrokerError } from "@/lib/capabilities/errors";
import { platformRecovery } from "@/lib/platform/recovery";
import { platformRoute } from "../_lib/http";
import { callerOf } from "../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATES = new Set(["pending", "resumed", "abandoned", "kept_uncertain"]);

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const state = req.nextUrl.searchParams.get("state") ?? undefined;
  if (state !== undefined && !STATES.has(state)) throw new BrokerError("invalid_request", "state must be pending, resumed, abandoned or kept_uncertain.");
  const service = await platformRecovery();
  const [status, items] = await Promise.all([
    service.status(caller.principal, caller.workspaceId),
    service.list(caller.principal, caller.workspaceId, { state: state as "pending" | undefined }),
  ]);
  return { body: { status, items } };
});
