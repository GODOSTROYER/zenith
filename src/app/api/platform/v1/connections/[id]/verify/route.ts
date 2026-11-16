/** POST /api/platform/v1/connections/:id/verify : observe-only identity readback (editor). */
import { idempotencyKey, personOrCredentialCaller, runLifecycle } from "../../../_lib/connections";
import { platformRoute } from "../../../_lib/http";
import { routeId } from "../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await personOrCredentialCaller(req);
  return runLifecycle(caller, "connection.verify", { connectionId: routeId(id) }, idempotencyKey(req));
});
