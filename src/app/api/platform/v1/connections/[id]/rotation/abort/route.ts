/** POST /api/platform/v1/connections/:id/rotation/abort : discard a staged rotation; the current access is untouched (admin; browser only). */
import { z } from "zod";
import { browserCaller, idempotencyKey, runLifecycle } from "../../../../_lib/connections";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { routeId } from "../../../../_lib/runbooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ rotationId: z.string().min(1).max(200) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await browserCaller(req);
  return runLifecycle(caller, "connection.abortRotation", { connectionId: routeId(id), ...parseWith(Body, await readJson(req)) }, idempotencyKey(req));
});
